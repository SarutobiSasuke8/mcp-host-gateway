import assert from "node:assert/strict";
import test from "node:test";

import { ErrorCode } from "../src/edge/errors.js";
import { createGateway } from "../src/edge/server.js";
import type { Gateway } from "../src/edge/server.js";
import { Logger } from "../src/log.js";
import { TokenBucketLimiter } from "../src/rate/index.js";
import { FREE_TOKEN, PAID_TOKEN, STATIC_TOKENS_ENV, bearer, rpc, staticConfig, startStubUpstream } from "./support.js";
import type { StubUpstream } from "./support.js";

interface Harness {
  gateway: Gateway;
  upstream: StubUpstream;
  base: string;
  logLines: string[];
  close(): Promise<void>;
}

async function harness(options: { sse?: boolean; upstreamStatus?: number } = {}): Promise<Harness> {
  const stubOptions: Parameters<typeof startStubUpstream>[0] = {};
  if (options.sse !== undefined) stubOptions.sse = options.sse;
  if (options.upstreamStatus !== undefined) stubOptions.status = options.upstreamStatus;
  const upstream = await startStubUpstream(stubOptions);
  const logLines: string[] = [];
  const logger = new Logger({ sink: { write: (line) => logLines.push(line) }, level: "debug" });
  const env = { GATEWAY_STATIC_TOKENS: STATIC_TOKENS_ENV, JOBSCOUT_UPSTREAM_AUTH: "Bearer upstream-secret-value" };
  const config = staticConfig(upstream.url);
  config.upstreams.jobscout!.auth_header_env = "JOBSCOUT_UPSTREAM_AUTH";
  const gateway = createGateway(config, { logger, env, limiter: new TokenBucketLimiter() });
  const port = await gateway.start();
  return {
    gateway,
    upstream,
    logLines,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await gateway.stop();
      await upstream.close();
    },
  };
}

const errorOf = (json: unknown): { code: number; message: string; data?: Record<string, unknown> } =>
  (json as { error: { code: number; message: string; data?: Record<string, unknown> } }).error;

void test("health and ready respond without tenant data", async () => {
  const h = await harness();
  try {
    const health = await fetch(`${h.base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const ready = await fetch(`${h.base}/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ready", auth_mode: "static", upstreams: 2 });
  } finally {
    await h.close();
  }
});

void test("unauthenticated calls are rejected with a JSON-RPC error and never reach the upstream", async () => {
  const h = await harness();
  try {
    const missing = await rpc(h.base, "jobscout", { jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get("www-authenticate"), 'Bearer realm="mcp-host-gateway"');
    assert.deepEqual(missing.json, {
      jsonrpc: "2.0",
      id: null,
      error: { code: ErrorCode.Unauthenticated, message: "Unauthenticated: missing Authorization header; expected Bearer <token>" },
    });

    const bad = await rpc(h.base, "jobscout", { jsonrpc: "2.0", id: 2, method: "ping" }, bearer("not-a-real-token-at-all"));
    assert.equal(bad.status, 401);
    assert.equal(errorOf(bad.json).code, ErrorCode.Unauthenticated);
    assert.equal(h.upstream.received.length, 0);
  } finally {
    await h.close();
  }
});

void test("an allowed tools/call is forwarded to the upstream and the tool result returned", async () => {
  const h = await harness();
  try {
    const init = await rpc(
      h.base,
      "jobscout",
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      bearer(PAID_TOKEN),
    );
    assert.equal(init.status, 200);
    assert.equal(init.headers.get("mcp-session-id"), "stub-session");

    const call = await rpc(
      h.base,
      "jobscout",
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_listing", arguments: { id: "abc" } } },
      { ...bearer(PAID_TOKEN), "Mcp-Session-Id": "stub-session", "MCP-Protocol-Version": "2025-06-18" },
    );
    assert.equal(call.status, 200);
    assert.deepEqual(call.json, {
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: 'called get_listing with {"id":"abc"}' }] },
    });
    assert.equal(call.headers.get("x-ratelimit-limit"), "300");

    const forwarded = h.upstream.received[1]!;
    assert.equal(forwarded.headers["mcp-session-id"], "stub-session");
    assert.equal(forwarded.headers["mcp-protocol-version"], "2025-06-18");
    assert.equal(forwarded.headers.authorization, "Bearer upstream-secret-value");
    assert.equal(h.upstream.received.length, 2);
  } finally {
    await h.close();
  }
});

void test("tools/list is filtered to the caller's grant, for JSON and SSE upstream framing", async () => {
  for (const sse of [false, true]) {
    const h = await harness({ sse });
    try {
      const free = await rpc(h.base, "jobscout", { jsonrpc: "2.0", id: 1, method: "tools/list" }, bearer(FREE_TOKEN));
      assert.equal(free.status, 200, `sse=${sse}`);
      assert.equal(free.headers.get("content-type"), "application/json");
      const freeTools = (free.json as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
      assert.deepEqual(freeTools, ["search_jobs"]);

      const paid = await rpc(h.base, "jobscout", { jsonrpc: "2.0", id: 2, method: "tools/list" }, bearer(PAID_TOKEN));
      const paidTools = (paid.json as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name).sort();
      assert.deepEqual(paidTools, ["get_listing", "search_jobs"]);
    } finally {
      await h.close();
    }
  }
});

void test("entitlement denies a tool and an upstream not on the caller's plan", async () => {
  const h = await harness();
  try {
    const tool = await rpc(
      h.base,
      "jobscout",
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_listing", arguments: {} } },
      bearer(FREE_TOKEN),
    );
    assert.equal(tool.status, 403);
    assert.equal(errorOf(tool.json).code, ErrorCode.Forbidden);
    assert.match(errorOf(tool.json).message, /tool "get_listing" is not available on plan "free"/);
    assert.equal((tool.json as { id: unknown }).id, 5);

    const upstream = await rpc(h.base, "source_pack", { jsonrpc: "2.0", id: 6, method: "ping" }, bearer(FREE_TOKEN));
    assert.equal(upstream.status, 403);
    assert.match(errorOf(upstream.json).message, /does not include upstream "source_pack"/);

    const unrouted = await rpc(h.base, "jobscout", { jsonrpc: "2.0", id: 7, method: "resources/list" }, bearer(PAID_TOKEN));
    assert.equal(unrouted.status, 404);
    assert.equal(errorOf(unrouted.json).code, ErrorCode.MethodNotFound);

    assert.equal(h.upstream.received.length, 0);
  } finally {
    await h.close();
  }
});

void test("rate limit is enforced per identity over HTTP", async () => {
  const h = await harness();
  try {
    for (let i = 0; i < 3; i += 1) {
      const ok = await rpc(h.base, "jobscout", { jsonrpc: "2.0", id: i, method: "ping" }, bearer(FREE_TOKEN));
      assert.equal(ok.status, 200, `call ${i + 1}`);
    }
    const over = await rpc(h.base, "jobscout", { jsonrpc: "2.0", id: 99, method: "ping" }, bearer(FREE_TOKEN));
    assert.equal(over.status, 429);
    assert.ok(over.headers.get("retry-after"));
    assert.equal(errorOf(over.json).code, ErrorCode.RateLimited);
    assert.equal(errorOf(over.json).data?.limit_rpm, 3);

    const other = await rpc(h.base, "jobscout", { jsonrpc: "2.0", id: 100, method: "ping" }, bearer(PAID_TOKEN));
    assert.equal(other.status, 200);
    assert.equal(h.upstream.received.length, 4);
  } finally {
    await h.close();
  }
});

void test("malformed requests, GET, and unknown upstream paths are refused clearly", async () => {
  const h = await harness();
  try {
    const batch = await rpc(h.base, "jobscout", [{ jsonrpc: "2.0", id: 1, method: "ping" }], bearer(PAID_TOKEN));
    assert.equal(batch.status, 400);
    assert.match(errorOf(batch.json).message, /batches are not supported/);

    const get = await fetch(`${h.base}/mcp/jobscout`, { headers: bearer(PAID_TOKEN) });
    assert.equal(get.status, 405);

    const missing = await rpc(h.base, "nothing", { jsonrpc: "2.0", id: 1, method: "ping" }, bearer(PAID_TOKEN));
    assert.equal(missing.status, 404);

    const nonJson = await fetch(`${h.base}/mcp/jobscout`, { method: "POST", headers: { ...bearer(PAID_TOKEN), "Content-Type": "text/plain" }, body: "hi" });
    assert.equal(nonJson.status, 400);
  } finally {
    await h.close();
  }
});

void test("upstream failures surface as a 502 JSON-RPC error, not a crash", async () => {
  const down = await harness({ upstreamStatus: 503 });
  try {
    const result = await rpc(down.base, "jobscout", { jsonrpc: "2.0", id: 1, method: "ping" }, bearer(PAID_TOKEN));
    assert.equal(result.status, 502);
    assert.equal(errorOf(result.json).code, ErrorCode.UpstreamUnavailable);
    assert.match(errorOf(result.json).message, /HTTP 503/);
  } finally {
    await down.close();
  }

  const h = await harness();
  try {
    await h.upstream.close();
    const result = await rpc(h.base, "jobscout", { jsonrpc: "2.0", id: 1, method: "ping" }, bearer(PAID_TOKEN));
    assert.equal(result.status, 502);
    assert.match(errorOf(result.json).message, /connection failed/);
  } finally {
    await h.gateway.stop();
  }
});

void test("logs carry subjects and outcomes but never bearer tokens or upstream credentials", async () => {
  const h = await harness();
  try {
    await rpc(h.base, "jobscout", { jsonrpc: "2.0", id: 1, method: "ping" }, bearer(PAID_TOKEN));
    await rpc(h.base, "jobscout", { jsonrpc: "2.0", id: 2, method: "ping" }, bearer("wrong-token-wrong-token"));
    const all = h.logLines.join("\n");
    assert.match(all, /"subject":"user-paid"/);
    assert.match(all, /"msg":"rejected"/);
    assert.doesNotMatch(all, new RegExp(PAID_TOKEN));
    assert.doesNotMatch(all, /upstream-secret-value/);
    assert.doesNotMatch(all, /wrong-token-wrong-token/);
  } finally {
    await h.close();
  }
});

void test("startup fails closed when the static token env var is absent", () => {
  const config = staticConfig("http://127.0.0.1:1/mcp");
  assert.throws(() => createGateway(config, { env: {} }), /GATEWAY_STATIC_TOKENS/);
});
