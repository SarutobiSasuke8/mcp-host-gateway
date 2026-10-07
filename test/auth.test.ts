import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { SignJWT, exportJWK, generateKeyPair } from "jose";

import { JwtAuthenticator, StaticAuthenticator, createAuthenticator, parseStaticTokens } from "../src/auth/index.js";
import { ConfigError, parseConfig } from "../src/config.js";
import { ErrorCode, GatewayError } from "../src/edge/errors.js";

const expectGatewayError = (code: number, pattern: RegExp) => (error: unknown): boolean =>
  error instanceof GatewayError && error.code === code && pattern.test(error.message);

void test("static mode: tokens come from the env var only and are parsed strictly", () => {
  const map = parseStaticTokens("aaaaaaaaaaaaaaaa:alice:free, bbbbbbbbbbbbbbbb:bob:paid");
  assert.deepEqual(map.get("aaaaaaaaaaaaaaaa"), { subject: "alice", plan: "free" });
  assert.deepEqual(map.get("bbbbbbbbbbbbbbbb"), { subject: "bob", plan: "paid" });

  assert.throws(() => parseStaticTokens("short:alice:free"), (e: unknown) => e instanceof ConfigError && /16 characters/.test(e.message));
  assert.throws(() => parseStaticTokens("aaaaaaaaaaaaaaaa:alice"), (e: unknown) => e instanceof ConfigError && /token:subject:plan/.test(e.message));
  assert.throws(() => parseStaticTokens(""), (e: unknown) => e instanceof ConfigError && /no tokens/.test(e.message));

  assert.throws(
    () => createAuthenticator({ mode: "static", tokens_env: "GATEWAY_TEST_UNSET" }, {}),
    (e: unknown) => e instanceof ConfigError && /GATEWAY_TEST_UNSET/.test(e.message),
  );
});

void test("static mode: missing, malformed and unknown bearer tokens are rejected with MCP-facing errors", async () => {
  const auth = new StaticAuthenticator(parseStaticTokens("aaaaaaaaaaaaaaaa:alice:free"));
  await assert.rejects(auth.authenticate(undefined), expectGatewayError(ErrorCode.Unauthenticated, /missing Authorization/));
  await assert.rejects(auth.authenticate("Basic abc"), expectGatewayError(ErrorCode.Unauthenticated, /Bearer <token>/));
  await assert.rejects(auth.authenticate("Bearer nope"), expectGatewayError(ErrorCode.Unauthenticated, /not recognised/));
  const identity = await auth.authenticate("Bearer aaaaaaaaaaaaaaaa");
  assert.deepEqual(identity, { subject: "alice", plan: "free", mode: "static" });
});

void test("jwt mode: verifies tokens against a JWKS endpoint and reads the plan claim", async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256", use: "sig" };
  const rogue = await generateKeyPair("ES256");

  const jwks = createServer((req, res) => {
    if (req.url === "/.well-known/jwks.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;

  try {
    const config = parseConfig({
      version: 1,
      auth: { mode: "jwt", issuer, audience: "mcp-host-gateway" },
      upstreams: { jobscout: { url: "http://127.0.0.1:1/mcp", tools_allow: ["search_jobs"] } },
      entitlements: { free: { upstreams: ["jobscout"], rpm: 30 } },
    });
    assert.equal(config.auth.mode, "jwt");
    if (config.auth.mode !== "jwt") return;
    const auth = new JwtAuthenticator(config.auth);
    await auth.verifyStartup();

    const sign = (claims: Record<string, unknown>, key: CryptoKey, opts: { aud?: string; exp?: string } = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", kid: "k1" })
        .setIssuer(issuer)
        .setAudience(opts.aud ?? "mcp-host-gateway")
        .setSubject("user-123")
        .setIssuedAt()
        .setExpirationTime(opts.exp ?? "5m")
        .sign(key);

    const good = await sign({ plan: "paid" }, privateKey);
    assert.deepEqual(await auth.authenticate(`Bearer ${good}`), { subject: "user-123", plan: "paid", mode: "jwt" });

    const noPlan = await sign({}, privateKey);
    assert.equal((await auth.authenticate(`Bearer ${noPlan}`)).plan, undefined);

    const wrongAud = await sign({ plan: "paid" }, privateKey, { aud: "someone-else" });
    await assert.rejects(auth.authenticate(`Bearer ${wrongAud}`), expectGatewayError(ErrorCode.Unauthenticated, /aud/));

    const expired = await sign({ plan: "paid" }, privateKey, { exp: "-1m" });
    await assert.rejects(auth.authenticate(`Bearer ${expired}`), expectGatewayError(ErrorCode.Unauthenticated, /expired/));

    const forged = await sign({ plan: "paid" }, rogue.privateKey);
    await assert.rejects(auth.authenticate(`Bearer ${forged}`), expectGatewayError(ErrorCode.Unauthenticated, /signature|rejected/));

    await assert.rejects(auth.authenticate("Bearer not.a.jwt"), expectGatewayError(ErrorCode.Unauthenticated, /rejected/));
  } finally {
    await new Promise<void>((resolve) => jwks.close(() => resolve()));
  }
});

void test("jwt mode: startup fails closed when the JWKS endpoint is unreachable", async () => {
  const config = parseConfig({
    version: 1,
    auth: { mode: "jwt", issuer: "http://127.0.0.1:1", audience: "mcp-host-gateway" },
    upstreams: { jobscout: { url: "http://127.0.0.1:1/mcp", tools_allow: ["search_jobs"] } },
    entitlements: { free: { upstreams: ["jobscout"], rpm: 30 } },
  });
  if (config.auth.mode !== "jwt") return;
  const auth = new JwtAuthenticator(config.auth);
  await assert.rejects(auth.verifyStartup(), (e: unknown) => e instanceof ConfigError && /JWKS fetch failed/.test(e.message));
});
