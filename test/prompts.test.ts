import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { GatewayConfig } from "../src/config.js";
import { ConfigError, parseConfig, parseConfigYaml } from "../src/config.js";
import { ErrorCode } from "../src/edge/errors.js";
import { createGateway } from "../src/edge/server.js";
import type { Gateway } from "../src/edge/server.js";
import { EntitlementMap } from "../src/entitlement/index.js";
import { silentLogger } from "../src/log.js";
import { TokenBucketLimiter } from "../src/rate/index.js";
import { filterInitializeResult } from "../src/router/index.js";
import { FREE_TOKEN, FULL_CAPABILITIES, PAID_TOKEN, STATIC_TOKENS_ENV, bearer, rpc, startStubUpstream } from "./support.js";
import type { StubUpstream } from "./support.js";

/**
 * Tools and prompts jobscout-mcp `main` really exposes (commit 621ddcf, src/server.ts). The
 * example config must name nothing outside these lists.
 */
const JOBSCOUT_TOOLS = [
  "jobscout_list_sources",
  "jobscout_search_jobs",
  "jobscout_classify_jobs",
  "jobscout_deduplicate",
  "jobscout_source_yield",
  "jobscout_briefing",
];
const JOBSCOUT_PROMPTS = ["jobscout_setup", "jobscout_find_jobs"];

/**
 * jobscout routes prompts (free gets none, paid gets two of three); source_pack has no
 * prompts_allow, so it must behave exactly as before prompts were supported.
 */
function promptConfig(upstreamUrl: string): GatewayConfig {
  return parseConfig({
    version: 1,
    listen: { host: "127.0.0.1", port: 0 },
    auth: { mode: "static", tokens_env: "GATEWAY_STATIC_TOKENS" },
    upstreams: {
      jobscout: { url: upstreamUrl, tools_allow: ["search_jobs", "get_listing"], prompts_allow: ["setup", "find_jobs"] },
      source_pack: { url: upstreamUrl, tools_allow: ["search_jobs"] },
    },
    entitlements: {
      free: { upstreams: ["jobscout"], rpm: 100, prompts: { jobscout: [] } },
      paid: { upstreams: ["jobscout", "source_pack"], rpm: 300 },
    },
  });
}

interface Harness {
  gateway: Gateway;
  upstream: StubUpstream;
  base: string;
  close(): Promise<void>;
}

async function harness(options: { sse?: boolean } = {}): Promise<Harness> {
  const stubOptions: Parameters<typeof startStubUpstream>[0] = { capabilities: FULL_CAPABILITIES };
  if (options.sse !== undefined) stubOptions.sse = options.sse;
  const upstream = await startStubUpstream(stubOptions);
  const gateway = createGateway(promptConfig(upstream.url), {
    logger: silentLogger,
    env: { GATEWAY_STATIC_TOKENS: STATIC_TOKENS_ENV },
    limiter: new TokenBucketLimiter(),
  });
  const port = await gateway.start();
  return {
    gateway,
    upstream,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await gateway.stop();
      await upstream.close();
    },
  };
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

const capabilitiesOf = (json: unknown): Record<string, unknown> =>
  (json as { result: { capabilities: Record<string, unknown> } }).result.capabilities;

const errorOf = (json: unknown): { code: number; message: string; data?: Record<string, unknown> } =>
  (json as { error: { code: number; message: string; data?: Record<string, unknown> } }).error;

void test("initialize advertises prompts only to a caller whose grant has prompts, for JSON and SSE framing", async () => {
  for (const sse of [false, true]) {
    const h = await harness({ sse });
    try {
      const free = await rpc(h.base, "jobscout", INIT, bearer(FREE_TOKEN));
      assert.equal(free.status, 200, `sse=${sse}`);
      assert.equal(free.headers.get("content-type"), "application/json");
      assert.deepEqual(capabilitiesOf(free.json), { tools: { listChanged: false } }, `sse=${sse}`);

      const paid = await rpc(h.base, "jobscout", INIT, bearer(PAID_TOKEN));
      assert.deepEqual(capabilitiesOf(paid.json), { tools: { listChanged: false }, prompts: { listChanged: false } }, `sse=${sse}`);
      // The rest of the initialize result is untouched.
      assert.deepEqual((paid.json as { result: { serverInfo: unknown } }).result.serverInfo, { name: "stub", version: "0" });

      // An upstream with no prompts_allow never advertises prompts, even to a paid caller.
      const other = await rpc(h.base, "source_pack", INIT, bearer(PAID_TOKEN));
      assert.deepEqual(capabilitiesOf(other.json), { tools: { listChanged: false } }, `sse=${sse}`);
    } finally {
      await h.close();
    }
  }
});

void test("prompts/list is filtered to the caller's grant", async () => {
  for (const sse of [false, true]) {
    const h = await harness({ sse });
    try {
      const paid = await rpc(h.base, "jobscout", { jsonrpc: "2.0", id: 2, method: "prompts/list" }, bearer(PAID_TOKEN));
      assert.equal(paid.status, 200);
      const names = (paid.json as { result: { prompts: Array<{ name: string }> } }).result.prompts.map((p) => p.name);
      assert.deepEqual(names, ["setup", "find_jobs"], `sse=${sse}`);

      const free = await rpc(h.base, "jobscout", { jsonrpc: "2.0", id: 3, method: "prompts/list" }, bearer(FREE_TOKEN));
      assert.equal(free.status, 200);
      assert.deepEqual((free.json as { result: { prompts: unknown[] } }).result.prompts, [], `sse=${sse}`);
    } finally {
      await h.close();
    }
  }
});

void test("prompts/get for a granted prompt is forwarded; an un-granted prompt is denied before the upstream", async () => {
  const h = await harness();
  try {
    const ok = await rpc(
      h.base,
      "jobscout",
      { jsonrpc: "2.0", id: 4, method: "prompts/get", params: { name: "find_jobs", arguments: { role: "engineer" } } },
      bearer(PAID_TOKEN),
    );
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, {
      jsonrpc: "2.0",
      id: 4,
      result: { messages: [{ role: "user", content: { type: "text", text: "prompt find_jobs" } }] },
    });
    assert.equal(h.upstream.received.length, 1);

    const hidden = await rpc(
      h.base,
      "jobscout",
      { jsonrpc: "2.0", id: 5, method: "prompts/get", params: { name: "internal_debug" } },
      bearer(PAID_TOKEN),
    );
    assert.equal(hidden.status, 403);
    assert.equal(errorOf(hidden.json).code, ErrorCode.Forbidden);
    assert.match(errorOf(hidden.json).message, /prompt "internal_debug" is not available on plan "paid" for upstream "jobscout"/);
    assert.deepEqual(errorOf(hidden.json).data, { plan: "paid", upstream: "jobscout", prompt: "internal_debug" });
    assert.equal((hidden.json as { id: unknown }).id, 5);

    const narrowed = await rpc(
      h.base,
      "jobscout",
      { jsonrpc: "2.0", id: 6, method: "prompts/get", params: { name: "setup" } },
      bearer(FREE_TOKEN),
    );
    assert.equal(narrowed.status, 403);
    assert.match(errorOf(narrowed.json).message, /prompt "setup" is not available on plan "free"/);

    const unnamed = await rpc(h.base, "jobscout", { jsonrpc: "2.0", id: 7, method: "prompts/get", params: {} }, bearer(PAID_TOKEN));
    assert.equal(unnamed.status, 400);
    assert.match(errorOf(unnamed.json).message, /prompts\/get requires params\.name/);

    // Only the one granted prompts/get reached the upstream.
    assert.equal(h.upstream.received.length, 1);
  } finally {
    await h.close();
  }
});

void test("an upstream without prompts_allow refuses prompts/* with -32601, exactly as before", async () => {
  const h = await harness();
  try {
    const list = await rpc(h.base, "source_pack", { jsonrpc: "2.0", id: 8, method: "prompts/list" }, bearer(PAID_TOKEN));
    assert.equal(list.status, 404);
    assert.equal(errorOf(list.json).code, ErrorCode.MethodNotFound);

    const get = await rpc(h.base, "source_pack", { jsonrpc: "2.0", id: 9, method: "prompts/get", params: { name: "setup" } }, bearer(PAID_TOKEN));
    assert.equal(get.status, 404);
    assert.equal(errorOf(get.json).code, ErrorCode.MethodNotFound);

    const resources = await rpc(h.base, "jobscout", { jsonrpc: "2.0", id: 10, method: "resources/list" }, bearer(PAID_TOKEN));
    assert.equal(resources.status, 404);
    assert.equal(h.upstream.received.length, 0);
  } finally {
    await h.close();
  }
});

void test("initialize rewrite drops every capability the gateway does not route", () => {
  const map = new EntitlementMap(promptConfig("http://127.0.0.1:1/mcp"));
  const paid = map.grant({ subject: "p", plan: "paid", mode: "static" }, "jobscout");
  const reply = { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: FULL_CAPABILITIES, instructions: "hi" } };
  assert.deepEqual(filterInitializeResult(reply, paid), {
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } }, instructions: "hi" },
  });
  // Error replies and odd shapes pass through untouched.
  const error = { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad version" } };
  assert.deepEqual(filterInitializeResult(error, paid), error);
});

void test("config rejects a plan prompt that is not in the upstream's prompts_allow", () => {
  const base = {
    version: 1,
    auth: { mode: "static" },
    upstreams: { jobscout: { url: "https://jobscout.internal/mcp", tools_allow: ["search_jobs"], prompts_allow: ["setup"] } },
  };
  assert.throws(
    () => parseConfig({ ...base, entitlements: { free: { upstreams: ["jobscout"], rpm: 30, prompts: { jobscout: ["admin_prompt"] } } } }),
    (error: unknown) => error instanceof ConfigError && /entitlements\.free\.prompts\.jobscout lists "admin_prompt" which is not in upstreams\.jobscout\.prompts_allow/.test(error.message),
  );
  // An upstream with no prompts_allow cannot be granted prompts by a plan.
  assert.throws(
    () =>
      parseConfig({
        ...base,
        upstreams: { jobscout: { url: "https://jobscout.internal/mcp", tools_allow: ["search_jobs"] } },
        entitlements: { free: { upstreams: ["jobscout"], rpm: 30, prompts: { jobscout: ["setup"] } } },
      }),
    (error: unknown) => error instanceof ConfigError && /not in upstreams\.jobscout\.prompts_allow/.test(error.message),
  );
  assert.throws(
    () => parseConfig({ ...base, entitlements: { free: { upstreams: ["jobscout"], rpm: 30, prompts: { other: ["setup"] } } } }),
    (error: unknown) => error instanceof ConfigError && /prompts references unknown upstream "other"/.test(error.message),
  );
  assert.throws(
    () => parseConfig({ ...base, upstreams: { jobscout: { url: "https://jobscout.internal/mcp", tools_allow: ["search_jobs"], prompts_allow: [] } }, entitlements: { free: { upstreams: ["jobscout"], rpm: 30 } } }),
    (error: unknown) => error instanceof ConfigError && /prompts_allow/.test(error.message),
  );
  assert.doesNotThrow(() => parseConfig({ ...base, entitlements: { free: { upstreams: ["jobscout"], rpm: 30, prompts: { jobscout: ["setup"] } } } }));
});

void test("the shipped example config validates and names only real JobScout tools and prompts", () => {
  const text = readFileSync(new URL("../../examples/gateway.example.yaml", import.meta.url), "utf8");
  const config = parseConfigYaml(text);
  const jobscout = config.upstreams.jobscout;
  assert.ok(jobscout, "example has a jobscout upstream");
  for (const tool of jobscout.tools_allow) assert.ok(JOBSCOUT_TOOLS.includes(tool), `example names unknown JobScout tool ${tool}`);
  assert.ok(jobscout.prompts_allow && jobscout.prompts_allow.length > 0, "example routes JobScout prompts");
  for (const prompt of jobscout.prompts_allow) assert.ok(JOBSCOUT_PROMPTS.includes(prompt), `example names unknown JobScout prompt ${prompt}`);
  for (const plan of Object.values(config.entitlements)) {
    for (const tool of plan.tools?.jobscout ?? []) assert.ok(JOBSCOUT_TOOLS.includes(tool));
    for (const prompt of plan.prompts?.jobscout ?? []) assert.ok(JOBSCOUT_PROMPTS.includes(prompt));
  }
});
