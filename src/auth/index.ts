import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";

import type { AuthConfig } from "../config.js";
import { ConfigError } from "../config.js";
import { unauthenticated } from "../edge/errors.js";

/** Who is calling. Carries no secret material, so it is safe to log. */
export interface Identity {
  subject: string;
  plan: string | undefined;
  mode: "jwt" | "static";
}

export interface Authenticator {
  readonly mode: "jwt" | "static";
  /** Resolve the Authorization header to an identity, or throw an MCP-facing GatewayError. */
  authenticate(authorizationHeader: string | undefined): Promise<Identity>;
  /** Startup probe. Throws if the authenticator cannot possibly work (fail closed). */
  verifyStartup(): Promise<void>;
}

function extractBearer(header: string | undefined): string {
  if (!header) throw unauthenticated("missing Authorization header; expected Bearer <token>");
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match || !match[1]) throw unauthenticated("Authorization header must be of the form Bearer <token>");
  return match[1];
}

/**
 * JWT via JWKS. Tokens are verified against the issuer's published keys, and both issuer and
 * audience must match the config exactly. The plan is read from a configurable claim.
 */
export class JwtAuthenticator implements Authenticator {
  readonly mode = "jwt" as const;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly jwksUrl: URL;
  private readonly planClaim: string;
  private readonly defaultPlan: string | undefined;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: Extract<AuthConfig, { mode: "jwt" }>) {
    this.issuer = config.issuer;
    this.audience = config.audience;
    this.jwksUrl = new URL(config.jwks_url ?? `${config.issuer.replace(/\/$/, "")}/.well-known/jwks.json`);
    this.planClaim = config.plan_claim;
    this.defaultPlan = config.default_plan;
    this.jwks = createRemoteJWKSet(this.jwksUrl, { cooldownDuration: 30_000, timeoutDuration: 5_000 });
  }

  async verifyStartup(): Promise<void> {
    // Fail closed if the JWKS endpoint cannot be reached at boot. A gateway that cannot
    // verify anything should not accept traffic.
    let response: Response;
    try {
      response = await fetch(this.jwksUrl, { signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      throw new ConfigError(`auth: JWKS fetch failed for ${this.jwksUrl.href}: ${(error as Error).message}`);
    }
    if (!response.ok) {
      throw new ConfigError(`auth: JWKS endpoint ${this.jwksUrl.href} returned HTTP ${response.status}`);
    }
    const body = (await response.json().catch(() => null)) as { keys?: unknown } | null;
    if (!body || !Array.isArray(body.keys) || body.keys.length === 0) {
      throw new ConfigError(`auth: JWKS endpoint ${this.jwksUrl.href} published no keys`);
    }
  }

  async authenticate(authorizationHeader: string | undefined): Promise<Identity> {
    const token = extractBearer(authorizationHeader);
    try {
      const { payload } = await jwtVerify(token, this.jwks, { issuer: this.issuer, audience: this.audience });
      if (!payload.sub) throw unauthenticated("token has no sub claim");
      const rawPlan = payload[this.planClaim];
      const plan = typeof rawPlan === "string" && rawPlan.length > 0 ? rawPlan : this.defaultPlan;
      return { subject: payload.sub, plan, mode: "jwt" };
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) throw unauthenticated("token expired");
      if (error instanceof joseErrors.JWTClaimValidationFailed) throw unauthenticated(`token claim invalid (${error.claim})`);
      if (error instanceof joseErrors.JWSSignatureVerificationFailed) throw unauthenticated("token signature invalid");
      if (error instanceof joseErrors.JOSEError) throw unauthenticated(`token rejected (${error.code})`);
      throw error;
    }
  }
}

export interface StaticTokenEntry {
  subject: string;
  plan: string;
}

/**
 * Parse "token:subject:plan,token2:subject2:plan2". Tokens come from an env var only. Entries
 * with the wrong shape are rejected outright so a typo cannot silently widen access.
 */
export function parseStaticTokens(value: string): Map<string, StaticTokenEntry> {
  const map = new Map<string, StaticTokenEntry>();
  for (const entry of value.split(",").map((s) => s.trim()).filter(Boolean)) {
    const parts = entry.split(":");
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
      throw new ConfigError("auth: static token entries must be token:subject:plan");
    }
    const [token, subject, plan] = parts as [string, string, string];
    if (token.length < 16) throw new ConfigError("auth: static tokens must be at least 16 characters");
    if (map.has(token)) throw new ConfigError("auth: duplicate static token");
    map.set(token, { subject, plan });
  }
  if (map.size === 0) throw new ConfigError("auth: static mode configured but no tokens supplied");
  return map;
}

/**
 * Static dev mode. Opaque tokens are read from an env var at startup; the map is never written
 * to disk and a committed config file cannot carry a token.
 */
export class StaticAuthenticator implements Authenticator {
  readonly mode = "static" as const;
  private readonly tokens: Map<string, StaticTokenEntry>;

  constructor(tokens: Map<string, StaticTokenEntry>) {
    this.tokens = tokens;
  }

  static fromEnv(config: Extract<AuthConfig, { mode: "static" }>, env: NodeJS.ProcessEnv = process.env): StaticAuthenticator {
    const value = env[config.tokens_env];
    if (!value || value.trim() === "") {
      throw new ConfigError(`auth: static mode requires env var ${config.tokens_env} (token:subject:plan,...)`);
    }
    return new StaticAuthenticator(parseStaticTokens(value));
  }

  async verifyStartup(): Promise<void> {
    if (this.tokens.size === 0) throw new ConfigError("auth: static mode has no tokens");
  }

  async authenticate(authorizationHeader: string | undefined): Promise<Identity> {
    const token = extractBearer(authorizationHeader);
    const entry = this.tokens.get(token);
    if (!entry) throw unauthenticated("token not recognised");
    return { subject: entry.subject, plan: entry.plan, mode: "static" };
  }
}

export function createAuthenticator(config: AuthConfig, env: NodeJS.ProcessEnv = process.env): Authenticator {
  if (config.mode === "static") return StaticAuthenticator.fromEnv(config, env);
  return new JwtAuthenticator(config);
}
