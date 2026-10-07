import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

const toolName = z.string().min(1).max(128);
const upstreamName = z.string().regex(/^[a-z0-9_-]+$/, "upstream names are lower-case [a-z0-9_-]");

const upstreamSchema = z.object({
  url: z.string().url(),
  tools_allow: z.array(toolName).min(1),
  // Name of an env var holding the full Authorization header value to send upstream.
  auth_header_env: z.string().min(1).optional(),
  timeout_ms: z.number().int().positive().max(120_000).default(30_000),
});

const planSchema = z.object({
  upstreams: z.array(upstreamName).min(1),
  rpm: z.number().int().positive(),
  // Optional per-plan narrowing of an upstream's tools_allow. Absent means "all of tools_allow".
  tools: z.record(upstreamName, z.array(toolName).min(1)).optional(),
});

const jwtAuthSchema = z.object({
  mode: z.literal("jwt").default("jwt"),
  issuer: z.string().url(),
  audience: z.string().min(1),
  // Defaults to <issuer>/.well-known/jwks.json. Set explicitly for IdPs that publish elsewhere.
  jwks_url: z.string().url().optional(),
  plan_claim: z.string().min(1).default("plan"),
  // Plan to assume when the token carries no plan claim. Absent means such tokens are denied.
  default_plan: z.string().min(1).optional(),
});

const staticAuthSchema = z.object({
  mode: z.literal("static"),
  // Env var holding "token:subject:plan,..." entries. Never a file path, never inline tokens.
  tokens_env: z.string().min(1).default("GATEWAY_STATIC_TOKENS"),
});

const configSchema = z.object({
  version: z.literal(1),
  listen: z
    .object({
      host: z.string().min(1).default("127.0.0.1"),
      port: z.number().int().min(0).max(65_535).default(8080),
    })
    .default({ host: "127.0.0.1", port: 8080 }),
  auth: z.discriminatedUnion("mode", [jwtAuthSchema, staticAuthSchema]),
  upstreams: z.record(upstreamName, upstreamSchema).refine((u) => Object.keys(u).length > 0, {
    message: "at least one upstream is required",
  }),
  entitlements: z.record(z.string().min(1), planSchema).refine((e) => Object.keys(e).length > 0, {
    message: "at least one entitlement plan is required",
  }),
  rate: z
    .object({
      // "identity": one bucket per caller. "identity_upstream": one bucket per caller per upstream.
      scope: z.enum(["identity", "identity_upstream"]).default("identity"),
    })
    .default({ scope: "identity" }),
});

export type GatewayConfig = z.infer<typeof configSchema>;
export type UpstreamConfig = GatewayConfig["upstreams"][string];
export type PlanConfig = GatewayConfig["entitlements"][string];
export type AuthConfig = GatewayConfig["auth"];

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Parse and validate a config object. Fails closed: any missing auth issuer, missing upstream,
 * or plan that references an unknown upstream or tool is an error, not a warning.
 */
export function parseConfig(raw: unknown): GatewayConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`invalid gateway config: ${detail}`);
  }
  const config = result.data;

  // JWT mode needs an issuer; the schema enforces the shape, but the YAML default of an
  // auth block without a mode must land here as JWT and still be checked for the issuer.
  if (config.auth.mode === "jwt" && config.auth.issuer.trim() === "") {
    throw new ConfigError("invalid gateway config: auth.issuer is required in jwt mode");
  }

  for (const [plan, entitlement] of Object.entries(config.entitlements)) {
    for (const name of entitlement.upstreams) {
      if (!(name in config.upstreams)) {
        throw new ConfigError(`invalid gateway config: entitlements.${plan} references unknown upstream "${name}"`);
      }
    }
    for (const [name, tools] of Object.entries(entitlement.tools ?? {})) {
      const upstream = config.upstreams[name];
      if (!upstream) {
        throw new ConfigError(`invalid gateway config: entitlements.${plan}.tools references unknown upstream "${name}"`);
      }
      if (!entitlement.upstreams.includes(name)) {
        throw new ConfigError(`invalid gateway config: entitlements.${plan}.tools.${name} is set but "${name}" is not in that plan's upstreams`);
      }
      for (const tool of tools) {
        if (!upstream.tools_allow.includes(tool)) {
          throw new ConfigError(`invalid gateway config: entitlements.${plan}.tools.${name} lists "${tool}" which is not in upstreams.${name}.tools_allow`);
        }
      }
    }
  }

  return config;
}

export function parseConfigYaml(text: string): GatewayConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`invalid gateway config: YAML parse failed: ${(error as Error).message}`);
  }
  // A YAML file that says only "auth: { issuer: ..., audience: ... }" should default to jwt mode.
  if (raw && typeof raw === "object" && "auth" in raw) {
    const auth = (raw as { auth?: unknown }).auth;
    if (auth && typeof auth === "object" && !("mode" in auth)) {
      (auth as Record<string, unknown>).mode = "jwt";
    }
  }
  return parseConfig(raw);
}

export function loadConfigFile(path: string): GatewayConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`cannot read gateway config at ${path}: ${(error as Error).message}`);
  }
  return parseConfigYaml(text);
}
