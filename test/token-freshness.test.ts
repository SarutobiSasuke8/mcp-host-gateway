import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { JWK } from "jose";

import { silentAudit } from "../src/audit.js";
import { JwtAuthenticator } from "../src/auth/index.js";
import type { GatewayConfig } from "../src/config.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { ErrorCode, GatewayError, bearerChallenge } from "../src/edge/errors.js";
import { createGateway } from "../src/edge/server.js";
import { silentLogger } from "../src/log.js";
import { TokenBucketLimiter } from "../src/rate/index.js";
import { bearer, rpc, startStubUpstream } from "./support.js";

/**
 * A local stand-in for a token issuer such as JobScout Pro: it publishes a JWKS whose keys can be
 * added (a personal access token is issued) or removed (it is revoked), and can be made to fail.
 * Everything runs on 127.0.0.1; no real issuer, token or account is involved.
 */
interface StubIssuer {
  issuer: string;
  hits: number;
  failing: boolean;
  /** Mint a key, publish it, and return a signer for tokens under it. */
  issue(kid?: string): Promise<{ kid: string; sign(claims?: Record<string, unknown>): Promise<string> }>;
  revoke(kid: string): void;
  close(): Promise<void>;
}

async function startStubIssuer(): Promise<StubIssuer> {
  const keys = new Map<string, JWK>();
  const state = { hits: 0, failing: false };
  const server: Server = createServer((req, res) => {
    if (req.url !== "/.well-known/jwks.json") {
      res.writeHead(404);
      res.end();
      return;
    }
    state.hits += 1;
    if (state.failing) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ keys: [...keys.values()] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    get hits() {
      return state.hits;
    },
    set hits(value: number) {
      state.hits = value;
    },
    get failing() {
      return state.failing;
    },
    set failing(value: boolean) {
      state.failing = value;
    },
    async issue(kid = `pat-${randomUUID()}`) {
      const { publicKey, privateKey } = await generateKeyPair("ES256");
      keys.set(kid, { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" });
      return {
        kid,
        sign: (claims: Record<string, unknown> = {}) =>
          new SignJWT({ plan: "paid", ...claims })
            .setProtectedHeader({ alg: "ES256", kid })
            .setIssuer(issuer)
            .setAudience("mcp-host-gateway")
            .setSubject("user-123")
            .setIssuedAt()
            .setExpirationTime("15m")
            .sign(privateKey),
      };
    },
    revoke(kid: string) {
      keys.delete(kid);
    },
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function jwtConfig(issuer: string, upstreamUrl = "http://127.0.0.1:1/mcp", auth: Record<string, unknown> = {}): GatewayConfig {
  return parseConfig({
    version: 1,
    listen: { host: "127.0.0.1", port: 0 },
    auth: { mode: "jwt", issuer, audience: "mcp-host-gateway", ...auth },
    upstreams: { jobscout: { url: upstreamUrl, tools_allow: ["search_jobs"] } },
    entitlements: { paid: { upstreams: ["jobscout"], rpm: 1000 } },
  });
}

function authenticatorAt(config: GatewayConfig, clock: { t: number }): JwtAuthenticator {
  if (config.auth.mode !== "jwt") throw new Error("expected jwt config");
  return new JwtAuthenticator(config.auth, { now: () => clock.t });
}

const isGatewayError = (code: number, status: number, pattern: RegExp) => (error: unknown): boolean =>
  error instanceof GatewayError && error.code === code && error.httpStatus === status && pattern.test(error.message);

void test("config: freshness defaults are seconds, and max stale may not undercut the refresh interval", () => {
  const config = jwtConfig("https://accounts.example.com");
  assert.equal(config.auth.mode, "jwt");
  if (config.auth.mode !== "jwt") return;
  assert.equal(config.auth.jwks_refresh_seconds, 5);
  assert.equal(config.auth.jwks_cooldown_seconds, 1);
  assert.equal(config.auth.jwks_max_stale_seconds, 60);
  assert.equal(config.auth.resource_metadata_url, undefined);
  assert.throws(
    () => jwtConfig("https://accounts.example.com", undefined, { jwks_refresh_seconds: 30, jwks_max_stale_seconds: 10 }),
    (e: unknown) => e instanceof ConfigError && /jwks_max_stale_seconds must be at least/.test(e.message),
  );
});

void test("revoke: a token whose key leaves the JWKS is refused once the cached set is jwks_refresh_seconds old", async () => {
  const issuer = await startStubIssuer();
  try {
    const clock = { t: 0 };
    const auth = authenticatorAt(jwtConfig(issuer.issuer), clock);
    const pat = await issuer.issue();
    await auth.verifyStartup();
    const token = await pat.sign();
    assert.equal((await auth.authenticate(`Bearer ${token}`)).subject, "user-123");

    issuer.revoke(pat.kid);
    // Inside the refresh window the cached set still holds the key: this is the documented bound.
    clock.t = 4_999;
    assert.equal((await auth.authenticate(`Bearer ${token}`)).subject, "user-123");
    assert.equal(issuer.hits, 1, "no refetch inside the refresh window");

    // At the refresh interval the next call refetches before verifying, and the key is gone.
    clock.t = 5_000;
    await assert.rejects(
      auth.authenticate(`Bearer ${token}`, "jobscout"),
      (error: unknown) =>
        isGatewayError(ErrorCode.Unauthenticated, 401, /signing key not recognised/)(error) &&
        /error="invalid_token"/.test((error as GatewayError).headers["WWW-Authenticate"] ?? ""),
    );
    assert.equal(issuer.hits, 2);
  } finally {
    await issuer.close();
  }
});

void test("new token: a key published after the last fetch verifies on its first call", async () => {
  const issuer = await startStubIssuer();
  try {
    const clock = { t: 0 };
    const auth = authenticatorAt(jwtConfig(issuer.issuer), clock);
    await issuer.issue("signing-1");
    await auth.verifyStartup();
    assert.equal(issuer.hits, 1);

    // Issued 1.5 s later, well inside the 5 s refresh window: the unknown kid triggers a refetch.
    clock.t = 1_500;
    const pat = await issuer.issue();
    const token = await pat.sign();
    assert.equal((await auth.authenticate(`Bearer ${token}`)).subject, "user-123");
    assert.equal(issuer.hits, 2, "exactly one refetch for the new key");
    assert.equal((await auth.authenticate(`Bearer ${token}`)).subject, "user-123");
    assert.equal(issuer.hits, 2, "the new key is now cached");

    // Worst case: issued within jwks_cooldown_seconds of the previous fetch. Refused once, then
    // accepted as soon as the cooldown has passed. That is the upper bound for a new token.
    clock.t = 1_600;
    const quick = await issuer.issue();
    const quickToken = await quick.sign();
    await assert.rejects(auth.authenticate(`Bearer ${quickToken}`), isGatewayError(ErrorCode.Unauthenticated, 401, /not recognised/));
    clock.t = 2_500;
    assert.equal((await auth.authenticate(`Bearer ${quickToken}`)).subject, "user-123");
  } finally {
    await issuer.close();
  }
});

void test("unknown key ids cannot make the gateway hammer the issuer", async () => {
  const issuer = await startStubIssuer();
  try {
    const clock = { t: 0 };
    const auth = authenticatorAt(jwtConfig(issuer.issuer), clock);
    const real = await issuer.issue("signing-1");
    await auth.verifyStartup();
    const forgedKids = await Promise.all(Array.from({ length: 20 }, () => issuer.issue()));
    for (const forged of forgedKids) issuer.revoke(forged.kid);
    const tokens = await Promise.all(forgedKids.map((f) => f.sign()));

    clock.t = 2_000;
    const results = await Promise.allSettled(tokens.map((t) => auth.authenticate(`Bearer ${t}`)));
    assert.ok(results.every((r) => r.status === "rejected"));
    assert.equal(issuer.hits, 2, "twenty concurrent unknown kids share one refetch");

    clock.t = 2_500;
    await assert.rejects(auth.authenticate(`Bearer ${tokens[0]}`));
    assert.equal(issuer.hits, 2, "no refetch inside the cooldown");
    assert.equal((await auth.authenticate(`Bearer ${await real.sign()}`)).subject, "user-123");
  } finally {
    await issuer.close();
  }
});

void test("issuer outage: last good keys serve until jwks_max_stale_seconds, then 503, then recovery", async () => {
  const issuer = await startStubIssuer();
  try {
    const clock = { t: 0 };
    const auth = authenticatorAt(jwtConfig(issuer.issuer), clock);
    const pat = await issuer.issue();
    await auth.verifyStartup();
    const token = await pat.sign();

    issuer.failing = true;
    clock.t = 6_000;
    assert.equal((await auth.authenticate(`Bearer ${token}`)).subject, "user-123", "stale but within max stale");
    clock.t = 6_500;
    assert.equal((await auth.authenticate(`Bearer ${token}`)).subject, "user-123");
    assert.equal(issuer.hits, 2, "failed refetches are retried no faster than the cooldown");

    clock.t = 60_001;
    await assert.rejects(
      auth.authenticate(`Bearer ${token}`),
      (error: unknown) =>
        isGatewayError(ErrorCode.AuthUnavailable, 503, /issuer cannot be reached/)(error) &&
        (error as GatewayError).headers["Retry-After"] === "1",
    );

    issuer.failing = false;
    clock.t = 61_500;
    assert.equal((await auth.authenticate(`Bearer ${token}`)).subject, "user-123");
  } finally {
    await issuer.close();
  }
});

void test("challenge: resource_metadata defaults to the issuer's RFC 9728 path and can be overridden", () => {
  const clock = { t: 0 };
  const byDefault = authenticatorAt(jwtConfig("https://pro.example.com/"), clock);
  assert.equal(byDefault.resourceMetadataUrl("jobscout"), "https://pro.example.com/.well-known/oauth-protected-resource/mcp/jobscout");
  assert.equal(byDefault.resourceMetadataUrl(), "https://pro.example.com/.well-known/oauth-protected-resource");

  const custom = authenticatorAt(
    jwtConfig("https://pro.example.com", undefined, { resource_metadata_url: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp/{upstream}" }),
    clock,
  );
  assert.equal(custom.resourceMetadataUrl("jobscout"), "https://mcp.example.com/.well-known/oauth-protected-resource/mcp/jobscout");

  // Quoting: a description can never break out of its quoted string.
  assert.equal(
    bearerChallenge({ error: "invalid_token", errorDescription: 'bad "x" \\ y\n' }),
    'Bearer realm="mcp-host-gateway", error="invalid_token", error_description="bad \\"x\\" \\\\ y"',
  );
});

void test("gateway 401s carry WWW-Authenticate with resource_metadata pointing at the issuer", async () => {
  const issuer = await startStubIssuer();
  const upstream = await startStubUpstream();
  const config = jwtConfig(issuer.issuer, upstream.url);
  const clock = { t: 0 };
  const authenticator = authenticatorAt(config, clock);
  const gateway = createGateway(config, { logger: silentLogger, audit: silentAudit, limiter: new TokenBucketLimiter(), authenticator });
  const pat = await issuer.issue();
  const port = await gateway.start();
  const base = `http://127.0.0.1:${port}`;
  const metadata = `${issuer.issuer}/.well-known/oauth-protected-resource/mcp/jobscout`;
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  try {
    const missing = await rpc(base, "jobscout", ping);
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get("www-authenticate"), `Bearer realm="mcp-host-gateway", resource_metadata="${metadata}"`);

    const malformed = await rpc(base, "jobscout", ping, { Authorization: "Basic abc" });
    assert.equal(malformed.status, 401);
    assert.match(malformed.headers.get("www-authenticate") ?? "", new RegExp(`resource_metadata="${metadata}", error="invalid_request"`));

    const token = await pat.sign();
    assert.equal((await rpc(base, "jobscout", ping, bearer(token))).status, 200);

    issuer.revoke(pat.kid);
    clock.t = 5_000;
    const revoked = await rpc(base, "jobscout", ping, bearer(token));
    assert.equal(revoked.status, 401);
    assert.equal((revoked.json as { error: { code: number } }).error.code, ErrorCode.Unauthenticated);
    assert.equal(
      revoked.headers.get("www-authenticate"),
      `Bearer realm="mcp-host-gateway", resource_metadata="${metadata}", error="invalid_token", error_description="token signing key not recognised (revoked or unknown)"`,
    );

    issuer.failing = true;
    clock.t = 120_000;
    const down = await rpc(base, "jobscout", ping, bearer(token));
    assert.equal(down.status, 503);
    assert.equal(down.headers.get("retry-after"), "1");
    assert.equal((down.json as { error: { code: number } }).error.code, ErrorCode.AuthUnavailable);
    assert.equal(upstream.received.length, 1, "only the one authenticated ping reached the upstream");
  } finally {
    await gateway.stop();
    await upstream.close();
    await issuer.close();
  }
});

void test("real clock, shipped defaults: revocation and a new token both take effect within seconds", async () => {
  const issuer = await startStubIssuer();
  const upstream = await startStubUpstream();
  const config = jwtConfig(issuer.issuer, upstream.url);
  const gateway = createGateway(config, { logger: silentLogger, audit: silentAudit, limiter: new TokenBucketLimiter() });
  const pat = await issuer.issue();
  const port = await gateway.start();
  const base = `http://127.0.0.1:${port}`;
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (token: string, status: number, limitMs: number): Promise<number> => {
    const started = Date.now();
    for (;;) {
      if ((await rpc(base, "jobscout", ping, bearer(token))).status === status) return Date.now() - started;
      if (Date.now() - started > limitMs) assert.fail(`no HTTP ${status} within ${limitMs} ms`);
      await pause(100);
    }
  };
  try {
    const token = await pat.sign();
    assert.equal((await rpc(base, "jobscout", ping, bearer(token))).status, 200);

    issuer.revoke(pat.kid);
    const revokedAfter = await until(token, 401, 7_000);
    console.log(`revocation evidence: revoked personal token refused after ${revokedAfter} ms (jwks_refresh_seconds=5)`);
    assert.ok(revokedAfter <= 6_000, `revocation took ${revokedAfter} ms`);

    const fresh = await issuer.issue();
    const newAfter = await until(await fresh.sign(), 200, 3_000);
    console.log(`new token evidence: new personal token accepted after ${newAfter} ms (jwks_cooldown_seconds=1)`);
    assert.ok(newAfter <= 1_500, `new token took ${newAfter} ms`);
  } finally {
    await gateway.stop();
    await upstream.close();
    await issuer.close();
  }
});
