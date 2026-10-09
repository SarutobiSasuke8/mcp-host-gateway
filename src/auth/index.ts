import { errors as joseErrors, jwtVerify } from "jose";
import type { JWTPayload } from "jose";

import type { AuthConfig } from "../config.js";
import { ConfigError } from "../config.js";
import type { BearerChallenge } from "../edge/errors.js";
import { authUnavailable, unauthenticated } from "../edge/errors.js";
import { JwksCache, JwksFetchError, JwksUnavailableError } from "./jwks.js";

/** Who is calling. Carries no secret material, so it is safe to log. */
export interface Identity {
  subject: string;
  plan: string | undefined;
  mode: "jwt" | "static";
}

export interface Authenticator {
  readonly mode: "jwt" | "static";
  /**
   * Resolve the Authorization header to an identity, or throw an MCP-facing GatewayError. The
   * upstream name, when given, shapes the resource metadata pointer in a 401's challenge.
   */
  authenticate(authorizationHeader: string | undefined, upstream?: string): Promise<Identity>;
  /** Startup probe. Throws if the authenticator cannot possibly work (fail closed). */
  verifyStartup(): Promise<void>;
}

function extractBearer(header: string | undefined, challenge: BearerChallenge): string {
  // No credentials at all: RFC 6750 says the challenge carries no error code.
  if (!header) throw unauthenticated("missing Authorization header; expected Bearer <token>", challenge);
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match || !match[1]) {
    throw unauthenticated("Authorization header must be of the form Bearer <token>", { ...challenge, error: "invalid_request" });
  }
  return match[1];
}

/** Test seams for the JWT authenticator. Production uses the defaults. */
export interface JwtAuthenticatorOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/**
 * JWT via JWKS. Tokens are verified against the issuer's published keys, and both issuer and
 * audience must match the config exactly. The plan is read from a configurable claim.
 *
 * Keys come from a short-lived cache (see JwksCache) so that a key the issuer removes, which is
 * how a personal access token is revoked, stops verifying within jwks_refresh_seconds, and a key
 * the issuer adds verifies on the first call that uses it.
 */
export class JwtAuthenticator implements Authenticator {
  readonly mode = "jwt" as const;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly jwksUrl: URL;
  private readonly planClaim: string;
  private readonly defaultPlan: string | undefined;
  private readonly resourceMetadataTemplate: string | undefined;
  private readonly retryAfterSeconds: number;
  readonly jwks: JwksCache;

  constructor(config: Extract<AuthConfig, { mode: "jwt" }>, options: JwtAuthenticatorOptions = {}) {
    this.issuer = config.issuer;
    this.audience = config.audience;
    this.jwksUrl = new URL(config.jwks_url ?? `${config.issuer.replace(/\/$/, "")}/.well-known/jwks.json`);
    this.planClaim = config.plan_claim;
    this.defaultPlan = config.default_plan;
    this.resourceMetadataTemplate = config.resource_metadata_url;
    this.retryAfterSeconds = Math.max(1, Math.ceil(config.jwks_cooldown_seconds));
    this.jwks = new JwksCache({
      url: this.jwksUrl,
      refreshMs: config.jwks_refresh_seconds * 1000,
      cooldownMs: config.jwks_cooldown_seconds * 1000,
      maxStaleMs: config.jwks_max_stale_seconds * 1000,
      timeoutMs: 5_000,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  /**
   * The RFC 9728 protected resource metadata URL for an upstream's MCP endpoint. Sent in every
   * 401 so an MCP client can discover the authorisation server without being told it.
   */
  resourceMetadataUrl(upstream?: string): string {
    if (this.resourceMetadataTemplate) {
      return this.resourceMetadataTemplate.replaceAll("{upstream}", upstream ?? "");
    }
    const base = `${this.issuer.replace(/\/+$/, "")}${RESOURCE_METADATA_PATH}`;
    return upstream ? `${base}/mcp/${upstream}` : base;
  }

  async verifyStartup(): Promise<void> {
    // Fail closed if the JWKS endpoint cannot be reached at boot. A gateway that cannot
    // verify anything should not accept traffic. This also primes the key cache.
    try {
      await this.jwks.refresh();
    } catch (error) {
      if (error instanceof JwksFetchError) throw new ConfigError(`auth: ${error.message}`);
      throw new ConfigError(`auth: JWKS fetch failed for ${this.jwksUrl.href}: ${(error as Error).message}`);
    }
    if (this.jwks.size === 0) {
      throw new ConfigError(`auth: JWKS endpoint ${this.jwksUrl.href} published no keys`);
    }
  }

  async authenticate(authorizationHeader: string | undefined, upstream?: string): Promise<Identity> {
    const challenge: BearerChallenge = { resourceMetadata: this.resourceMetadataUrl(upstream) };
    const reject = (reason: string) => unauthenticated(reason, { ...challenge, error: "invalid_token" });
    const token = extractBearer(authorizationHeader, challenge);
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks.getKey, { issuer: this.issuer, audience: this.audience }));
    } catch (error) {
      if (error instanceof JwksUnavailableError) throw authUnavailable(this.retryAfterSeconds);
      if (error instanceof joseErrors.JWTExpired) throw reject("token expired");
      if (error instanceof joseErrors.JWTClaimValidationFailed) throw reject(`token claim invalid (${error.claim})`);
      if (error instanceof joseErrors.JWSSignatureVerificationFailed) throw reject("token signature invalid");
      if (error instanceof joseErrors.JWKSNoMatchingKey) throw reject("token signing key not recognised (revoked or unknown)");
      if (error instanceof joseErrors.JOSEError) throw reject(`token rejected (${error.code})`);
      throw error;
    }
    if (!payload.sub) throw reject("token has no sub claim");
    const rawPlan = payload[this.planClaim];
    const plan = typeof rawPlan === "string" && rawPlan.length > 0 ? rawPlan : this.defaultPlan;
    return { subject: payload.sub, plan, mode: "jwt" };
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
 * to disk and a committed config file cannot carry a token. There is no issuer, so the 401
 * challenge carries no resource metadata pointer.
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
    const token = extractBearer(authorizationHeader, {});
    const entry = this.tokens.get(token);
    if (!entry) throw unauthenticated("token not recognised", { error: "invalid_token" });
    return { subject: entry.subject, plan: entry.plan, mode: "static" };
  }
}

export function createAuthenticator(config: AuthConfig, env: NodeJS.ProcessEnv = process.env): Authenticator {
  if (config.mode === "static") return StaticAuthenticator.fromEnv(config, env);
  return new JwtAuthenticator(config);
}
