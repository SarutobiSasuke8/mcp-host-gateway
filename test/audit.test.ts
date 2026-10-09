import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AUDIT_KEYS, AuditLog, createAuditLog } from "../src/audit.js";
import { createGateway } from "../src/edge/server.js";
import { silentLogger } from "../src/log.js";
import { TokenBucketLimiter } from "../src/rate/index.js";
import { FREE_TOKEN, PAID_TOKEN, STATIC_TOKENS_ENV, bearer, rpc, staticConfig, startStubUpstream } from "./support.js";

const UPSTREAM_SECRET = "Bearer upstream-secret-AUDIT-CANARY-1";
const ARG_CANARY = "ARGUMENT-BODY-CANARY-7f3a";
const WRONG_TOKEN = "wrong-token-AUDIT-CANARY-0123456789";
const JWT_LIKE = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.c2lnbmF0dXJlY2FuYXJ5";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertSchema(line: string): Record<string, unknown> {
  const entry = JSON.parse(line) as Record<string, unknown>;
  assert.deepEqual(Object.keys(entry), [...AUDIT_KEYS], "every audit line carries exactly the documented keys, in order");
  assert.equal(typeof entry.ts, "string");
  assert.ok(!Number.isNaN(Date.parse(entry.ts as string)));
  assert.match(entry.request_id as string, UUID);
  for (const key of ["subject", "plan", "method", "tool", "prompt", "reason"]) {
    assert.ok(entry[key] === null || typeof entry[key] === "string", `${key} is string or null`);
  }
  assert.equal(typeof entry.upstream, "string");
  assert.ok(["allow", "deny", "rate_limited", "upstream_error"].includes(entry.decision as string));
  assert.ok(Number.isInteger(entry.status));
  assert.ok(Number.isInteger(entry.duration_ms) && (entry.duration_ms as number) >= 0);
  return entry;
}

void test("one schema-conformant audit line per routed call, with no tokens, credentials or bodies", async () => {
  const upstream = await startStubUpstream();
  const lines: string[] = [];
  const config = staticConfig(upstream.url);
  config.upstreams.jobscout!.auth_header_env = "JOBSCOUT_UPSTREAM_AUTH";
  const gateway = createGateway(config, {
    logger: silentLogger,
    env: { GATEWAY_STATIC_TOKENS: STATIC_TOKENS_ENV, JOBSCOUT_UPSTREAM_AUTH: UPSTREAM_SECRET },
    limiter: new TokenBucketLimiter(),
    audit: new AuditLog({ write: (line) => lines.push(line) }),
  });
  const base = `http://127.0.0.1:${await gateway.start()}`;
  try {
    const calls: Array<Promise<{ status: number; headers: Headers }>> = [];
    // allow: tool call whose arguments carry a canary (and a JWT-shaped value)
    const allowed = await rpc(base, "jobscout", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_jobs", arguments: { q: ARG_CANARY, t: JWT_LIKE } } }, bearer(PAID_TOKEN));
    assert.equal(allowed.status, 200);
    // The stub echoes the arguments, so the response body carries the canary too.
    assert.match(JSON.stringify(allowed.json), new RegExp(ARG_CANARY));
    // deny: tool not on plan
    calls.push(rpc(base, "jobscout", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_listing", arguments: { q: ARG_CANARY } } }, bearer(FREE_TOKEN)));
    // deny: unauthenticated with a wrong token
    calls.push(rpc(base, "jobscout", { jsonrpc: "2.0", id: 3, method: "ping" }, bearer(WRONG_TOKEN)));
    // deny: un-routed method
    calls.push(rpc(base, "jobscout", { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: ARG_CANARY } }, bearer(PAID_TOKEN)));
    await Promise.all(calls);
    // rate_limited: free plan rpm 3, one spent above, so two pings pass and the third is limited
    for (let i = 0; i < 3; i += 1) await rpc(base, "jobscout", { jsonrpc: "2.0", id: 10 + i, method: "ping" }, bearer(FREE_TOKEN));
    // upstream_error: upstream goes away
    await upstream.close();
    const down = await rpc(base, "jobscout", { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "search_jobs", arguments: { q: ARG_CANARY } } }, bearer(PAID_TOKEN));
    assert.equal(down.status, 502);
    assert.ok(allowed.headers.get("x-request-id")?.match(UUID), "request id is returned to the client");

    assert.equal(lines.length, 8, "one line per routed call");
    const entries = lines.map(assertSchema);

    const all = lines.join("\n");
    for (const secret of [PAID_TOKEN, FREE_TOKEN, WRONG_TOKEN, UPSTREAM_SECRET, "upstream-secret", ARG_CANARY, JWT_LIKE, "Bearer"]) {
      assert.ok(!all.includes(secret), `audit log must not contain ${secret}`);
    }
    for (const bodyKey of ["arguments", "params", "result", "content", "jsonrpc", "authorization"]) {
      assert.ok(!all.toLowerCase().includes(`"${bodyKey}"`), `audit log must not carry a ${bodyKey} field`);
    }

    const allowedEntry = entries.find((e) => e.request_id === allowed.headers.get("x-request-id"))!;
    assert.deepEqual(
      { ...allowedEntry, ts: undefined, request_id: undefined, duration_ms: undefined },
      { ts: undefined, request_id: undefined, subject: "user-paid", plan: "paid", upstream: "jobscout", method: "tools/call", tool: "search_jobs", prompt: null, decision: "allow", reason: null, status: 200, duration_ms: undefined },
    );

    const decisions = entries.map((e) => e.decision).sort();
    assert.deepEqual(decisions, ["allow", "allow", "allow", "deny", "deny", "deny", "rate_limited", "upstream_error"].sort());

    const unauth = entries.find((e) => e.status === 401)!;
    assert.equal(unauth.subject, null);
    assert.equal(unauth.decision, "deny");
    assert.match(unauth.reason as string, /token not recognised/);

    const toolDeny = entries.find((e) => e.status === 403)!;
    assert.equal(toolDeny.tool, "get_listing");
    assert.equal(toolDeny.plan, "free");

    const limited = entries.filter((e) => e.decision === "rate_limited");
    assert.ok(limited.every((e) => e.status === 429 && e.method === "ping" && e.subject === "user-free"));

    const upstreamError = entries.find((e) => e.decision === "upstream_error")!;
    assert.equal(upstreamError.status, 502);
    assert.match(upstreamError.reason as string, /connection failed/);
  } finally {
    await gateway.stop();
  }
});

void test("file sink appends one line per entry and redacts token-shaped values a client smuggles into names", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-gw-audit-"));
  try {
    const path = join(dir, "logs", "audit.jsonl");
    const audit = createAuditLog({ sink: "file", path });
    const base = { request_id: "00000000-0000-4000-8000-000000000000", subject: "s", plan: "p", upstream: "u", method: "tools/call", prompt: null, decision: "deny" as const, reason: null, status: 403, duration_ms: 1 };
    audit.record({ ...base, tool: `Bearer ${PAID_TOKEN}` });
    audit.record({ ...base, tool: JWT_LIKE });
    audit.record({ ...base, tool: "x".repeat(1000) });
    audit.close();
    const text = readFileSync(path, "utf8");
    const lines = text.trim().split("\n");
    assert.equal(lines.length, 3);
    lines.forEach(assertSchema);
    assert.ok(!text.includes(PAID_TOKEN));
    assert.ok(!text.includes(JWT_LIKE));
    assert.ok((JSON.parse(lines[2]!) as { tool: string }).tool.length <= 260);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
