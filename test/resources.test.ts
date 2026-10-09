import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { silentAudit } from "../src/audit.js";
import type { GatewayConfig } from "../src/config.js";
import { ConfigError, parseConfig, parseConfigYaml } from "../src/config.js";
import { ErrorCode } from "../src/edge/errors.js";
import { createGateway } from "../src/edge/server.js";
import type { Gateway } from "../src/edge/server.js";
import { EntitlementMap, resourceAllowed } from "../src/entitlement/index.js";
import { silentLogger } from "../src/log.js";
import { TokenBucketLimiter } from "../src/rate/index.js";
import { filterInitializeResult, filterResourceTemplatesList, filterResourcesList } from "../src/router/index.js";
import { FREE_TOKEN, FULL_CAPABILITIES, PAID_TOKEN, STATIC_TOKENS_ENV, bearer, rpc, startStubUpstream } from "./support.js";
import type { StubUpstream } from "./support.js";

/**
 * docs routes resources: paid callers get both public docs and job snapshots, free callers are
 * narrowed to the public docs. source_pack has no resources_allow, so it must behave exactly as
 * before resources were supported. The stub also lists docs://internal/... which no plan grants.
 */
function resourceConfig(upstreamUrl: string): GatewayConfig {
  return parseConfig({
    version: 1,
    listen: { host: "127.0.0.1", port: 0 },
    auth: { mode: "static", tokens_env: "GATEWAY_STATIC_TOKENS" },
    upstreams: {
      docs: { url: upstreamUrl, tools_allow: ["search_jobs"], resources_allow: ["docs://public/", "jobs://snapshots/"] },
      source_pack: { url: upstreamUrl, tools_allow: ["search_jobs"] },
    },
    entitlements: {
      free: { upstreams: ["docs"], rpm: 100, resources: { docs: ["docs://public/"] } },
      paid: { upstreams: ["docs", "source_pack"], rpm: 300 },
      none: { upstreams: ["docs"], rpm: 100, resources: { docs: [] } },
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
  const gateway = createGateway(resourceConfig(upstream.url), {
    logger: silentLogger,
    env: { GATEWAY_STATIC_TOKENS: STATIC_TOKENS_ENV },
    limiter: new TokenBucketLimiter(),
    audit: silentAudit,
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

const urisOf = (json: unknown): string[] =>
  (json as { result: { resources: Array<{ uri: string }> } }).result.resources.map((r) => r.uri);

const templatesOf = (json: unknown): string[] =>
  (json as { result: { resourceTemplates: Array<{ uriTemplate: string }> } }).result.resourceTemplates.map((r) => r.uriTemplate);

void test("initialize advertises resources only to a caller whose grant has a prefix, never with subscribe, for JSON and SSE framing", async () => {
  for (const sse of [false, true]) {
    const h = await harness({ sse });
    try {
      const paid = await rpc(h.base, "docs", INIT, bearer(PAID_TOKEN));
      assert.equal(paid.status, 200, `sse=${sse}`);
      assert.equal(paid.headers.get("content-type"), sse ? "text/event-stream" : "application/json");
      // The stub offers resources: { subscribe: true }; the gateway advertises resources but not subscribe.
      assert.deepEqual(capabilitiesOf(paid.json), { tools: { listChanged: false }, resources: {} }, `sse=${sse}`);

      const free = await rpc(h.base, "docs", INIT, bearer(FREE_TOKEN));
      assert.deepEqual(capabilitiesOf(free.json), { tools: { listChanged: false }, resources: {} }, `sse=${sse}`);

      // An upstream with no resources_allow never advertises resources, even to a paid caller.
      const other = await rpc(h.base, "source_pack", INIT, bearer(PAID_TOKEN));
      assert.deepEqual(capabilitiesOf(other.json), { tools: { listChanged: false } }, `sse=${sse}`);
    } finally {
      await h.close();
    }
  }
});

void test("resources/list and resources/templates/list are filtered to the caller's prefixes", async () => {
  for (const sse of [false, true]) {
    const h = await harness({ sse });
    try {
      const paid = await rpc(h.base, "docs", { jsonrpc: "2.0", id: 2, method: "resources/list" }, bearer(PAID_TOKEN));
      assert.equal(paid.status, 200);
      assert.deepEqual(urisOf(paid.json), ["docs://public/readme", "docs://public/schema.json", "jobs://snapshots/latest"], `sse=${sse}`);

      const free = await rpc(h.base, "docs", { jsonrpc: "2.0", id: 3, method: "resources/list" }, bearer(FREE_TOKEN));
      assert.equal(free.status, 200);
      assert.deepEqual(urisOf(free.json), ["docs://public/readme", "docs://public/schema.json"], `sse=${sse}`);

      const paidTemplates = await rpc(h.base, "docs", { jsonrpc: "2.0", id: 4, method: "resources/templates/list" }, bearer(PAID_TOKEN));
      assert.equal(paidTemplates.status, 200);
      // jobs://{kind}/latest could expand outside jobs://snapshots/, so it is dropped.
      assert.deepEqual(templatesOf(paidTemplates.json), ["docs://public/{slug}"], `sse=${sse}`);

      const freeTemplates = await rpc(h.base, "docs", { jsonrpc: "2.0", id: 5, method: "resources/templates/list" }, bearer(FREE_TOKEN));
      assert.deepEqual(templatesOf(freeTemplates.json), ["docs://public/{slug}"], `sse=${sse}`);
    } finally {
      await h.close();
    }
  }
});

void test("resources/read inside a granted prefix is forwarded; outside it is denied before the upstream in the tool error shape", async () => {
  const h = await harness();
  try {
    const ok = await rpc(h.base, "docs", { jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: "docs://public/readme" } }, bearer(FREE_TOKEN));
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, {
      jsonrpc: "2.0",
      id: 6,
      result: { contents: [{ uri: "docs://public/readme", mimeType: "text/plain", text: "contents of docs://public/readme" }] },
    });
    assert.equal(h.upstream.received.length, 1);

    // Outside every upstream prefix: forbidden, same shape as a denied tool.
    const hidden = await rpc(h.base, "docs", { jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "docs://internal/runbook" } }, bearer(PAID_TOKEN));
    assert.equal(hidden.status, 403);
    assert.equal(errorOf(hidden.json).code, ErrorCode.Forbidden);
    assert.match(errorOf(hidden.json).message, /resource "docs:\/\/internal\/runbook" is not available on plan "paid" for upstream "docs"/);
    assert.deepEqual(errorOf(hidden.json).data, { plan: "paid", upstream: "docs", resource: "docs://internal/runbook" });
    assert.equal((hidden.json as { id: unknown }).id, 7);

    // Inside an upstream prefix but outside the plan's narrowing.
    const narrowed = await rpc(h.base, "docs", { jsonrpc: "2.0", id: 8, method: "resources/read", params: { uri: "jobs://snapshots/latest" } }, bearer(FREE_TOKEN));
    assert.equal(narrowed.status, 403);
    assert.match(errorOf(narrowed.json).message, /resource "jobs:\/\/snapshots\/latest" is not available on plan "free"/);

    // A prefix is a prefix: "docs://public" without the slash does not open "docs://publicity".
    const sibling = await rpc(h.base, "docs", { jsonrpc: "2.0", id: 9, method: "resources/read", params: { uri: "docs://publicity/leak" } }, bearer(PAID_TOKEN));
    assert.equal(sibling.status, 403);

    const unnamed = await rpc(h.base, "docs", { jsonrpc: "2.0", id: 10, method: "resources/read", params: {} }, bearer(PAID_TOKEN));
    assert.equal(unnamed.status, 400);
    assert.match(errorOf(unnamed.json).message, /resources\/read requires params\.uri/);

    // Only the one granted read reached the upstream.
    assert.equal(h.upstream.received.length, 1);
  } finally {
    await h.close();
  }
});

void test("an upstream without resources_allow refuses resources/* with -32601, exactly as before; subscribe is never routed", async () => {
  const h = await harness();
  try {
    for (const method of ["resources/list", "resources/templates/list"]) {
      const reply = await rpc(h.base, "source_pack", { jsonrpc: "2.0", id: 11, method }, bearer(PAID_TOKEN));
      assert.equal(reply.status, 404, method);
      assert.equal(errorOf(reply.json).code, ErrorCode.MethodNotFound, method);
    }
    const read = await rpc(h.base, "source_pack", { jsonrpc: "2.0", id: 12, method: "resources/read", params: { uri: "docs://public/readme" } }, bearer(PAID_TOKEN));
    assert.equal(read.status, 404);
    assert.equal(errorOf(read.json).code, ErrorCode.MethodNotFound);

    // Even on an upstream that routes resources, subscribe and unsubscribe do not exist.
    for (const method of ["resources/subscribe", "resources/unsubscribe"]) {
      const reply = await rpc(h.base, "docs", { jsonrpc: "2.0", id: 13, method, params: { uri: "docs://public/readme" } }, bearer(PAID_TOKEN));
      assert.equal(reply.status, 404, method);
      assert.equal(errorOf(reply.json).code, ErrorCode.MethodNotFound, method);
    }

    // The other upstream's prompts are still deny by default alongside resources.
    const prompts = await rpc(h.base, "docs", { jsonrpc: "2.0", id: 14, method: "prompts/list" }, bearer(PAID_TOKEN));
    assert.equal(prompts.status, 404);
    assert.equal(h.upstream.received.length, 0);
  } finally {
    await h.close();
  }
});

void test("a plan narrowed to no resources is routed but sees nothing and advertises nothing", async () => {
  const h = await harness();
  try {
    const noneToken = "test-none-token-0123456789";
    await h.gateway.stop();
    const gateway = createGateway(resourceConfig(h.upstream.url), {
      logger: silentLogger,
      env: { GATEWAY_STATIC_TOKENS: `${STATIC_TOKENS_ENV},${noneToken}:user-none:none` },
      limiter: new TokenBucketLimiter(),
      audit: silentAudit,
    });
    const port = await gateway.start();
    try {
      const base = `http://127.0.0.1:${port}`;
      const init = await rpc(base, "docs", INIT, bearer(noneToken));
      assert.deepEqual(capabilitiesOf(init.json), { tools: { listChanged: false } });
      const list = await rpc(base, "docs", { jsonrpc: "2.0", id: 15, method: "resources/list" }, bearer(noneToken));
      assert.equal(list.status, 200);
      assert.deepEqual(urisOf(list.json), []);
      const read = await rpc(base, "docs", { jsonrpc: "2.0", id: 16, method: "resources/read", params: { uri: "docs://public/readme" } }, bearer(noneToken));
      assert.equal(read.status, 403);
      assert.equal(errorOf(read.json).code, ErrorCode.Forbidden);
    } finally {
      await gateway.stop();
    }
  } finally {
    await h.upstream.close();
  }
});

void test("filters and the prefix match are pure functions over the grant", () => {
  const map = new EntitlementMap(resourceConfig("http://127.0.0.1:1/mcp"));
  const paid = map.grant({ subject: "p", plan: "paid", mode: "static" }, "docs");
  const plain = map.grant({ subject: "p", plan: "paid", mode: "static" }, "source_pack");
  assert.deepEqual(paid.resources, ["docs://public/", "jobs://snapshots/"]);
  assert.equal(paid.resourcesRouted, true);
  assert.deepEqual(plain.resources, []);
  assert.equal(plain.resourcesRouted, false);

  assert.equal(resourceAllowed(["docs://public/"], "docs://public/readme"), true);
  assert.equal(resourceAllowed(["docs://public/"], "docs://public"), false);
  assert.equal(resourceAllowed([], "docs://public/readme"), false);

  const reply = { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: FULL_CAPABILITIES, instructions: "hi" } };
  assert.deepEqual(filterInitializeResult(reply, paid), {
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false }, resources: {} }, instructions: "hi" },
  });
  // listChanged is kept on resources; only subscribe is removed.
  const listChanged = { jsonrpc: "2.0", id: 1, result: { capabilities: { tools: {}, resources: { subscribe: true, listChanged: true } } } };
  assert.deepEqual(filterInitializeResult(listChanged, paid), { jsonrpc: "2.0", id: 1, result: { capabilities: { tools: {}, resources: { listChanged: true } } } });

  // Items without a string uri are dropped; odd shapes and error replies pass through.
  const list = { jsonrpc: "2.0", id: 2, result: { resources: [{ uri: "docs://public/a" }, { name: "no uri" }, null, { uri: "docs://internal/b" }], nextCursor: "n" } };
  assert.deepEqual(filterResourcesList(list, paid), { jsonrpc: "2.0", id: 2, result: { resources: [{ uri: "docs://public/a" }], nextCursor: "n" } });
  const error = { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "bad cursor" } };
  assert.deepEqual(filterResourcesList(error, paid), error);
  assert.deepEqual(filterResourcesList("not an object", paid), "not an object");

  const templates = { jsonrpc: "2.0", id: 3, result: { resourceTemplates: [{ uriTemplate: "docs://public/{slug}" }, { uriTemplate: "docs://{area}/x" }, { uriTemplate: "jobs://snapshots/{day}" }, { uriTemplate: "jobs://snapshots/fixed" }] } };
  assert.deepEqual(filterResourceTemplatesList(templates, paid), {
    jsonrpc: "2.0",
    id: 3,
    result: { resourceTemplates: [{ uriTemplate: "docs://public/{slug}" }, { uriTemplate: "jobs://snapshots/{day}" }, { uriTemplate: "jobs://snapshots/fixed" }] },
  });
});

void test("config rejects a plan resource prefix that is not within the upstream's resources_allow", () => {
  const base = {
    version: 1,
    auth: { mode: "static" },
    upstreams: { docs: { url: "https://docs.internal/mcp", tools_allow: ["search_jobs"], resources_allow: ["docs://public/"] } },
  };
  assert.throws(
    () => parseConfig({ ...base, entitlements: { free: { upstreams: ["docs"], rpm: 30, resources: { docs: ["docs://internal/"] } } } }),
    (error: unknown) => error instanceof ConfigError && /entitlements\.free\.resources\.docs lists "docs:\/\/internal\/" which is not within upstreams\.docs\.resources_allow/.test(error.message),
  );
  // A plan prefix may not widen the upstream prefix.
  assert.throws(
    () => parseConfig({ ...base, entitlements: { free: { upstreams: ["docs"], rpm: 30, resources: { docs: ["docs://"] } } } }),
    (error: unknown) => error instanceof ConfigError && /not within upstreams\.docs\.resources_allow/.test(error.message),
  );
  // An upstream with no resources_allow cannot be granted resources by a plan.
  assert.throws(
    () =>
      parseConfig({
        ...base,
        upstreams: { docs: { url: "https://docs.internal/mcp", tools_allow: ["search_jobs"] } },
        entitlements: { free: { upstreams: ["docs"], rpm: 30, resources: { docs: ["docs://public/"] } } },
      }),
    (error: unknown) => error instanceof ConfigError && /not within upstreams\.docs\.resources_allow/.test(error.message),
  );
  assert.throws(
    () => parseConfig({ ...base, entitlements: { free: { upstreams: ["docs"], rpm: 30, resources: { other: ["docs://public/"] } } } }),
    (error: unknown) => error instanceof ConfigError && /resources references unknown upstream "other"/.test(error.message),
  );
  assert.throws(
    () => parseConfig({ ...base, upstreams: { docs: { url: "https://docs.internal/mcp", tools_allow: ["search_jobs"], resources_allow: [] } }, entitlements: { free: { upstreams: ["docs"], rpm: 30 } } }),
    (error: unknown) => error instanceof ConfigError && /resources_allow/.test(error.message),
  );
  // Prefixes are plain strings: no template braces, no whitespace.
  assert.throws(
    () => parseConfig({ ...base, upstreams: { docs: { url: "https://docs.internal/mcp", tools_allow: ["search_jobs"], resources_allow: ["docs://{area}/"] } }, entitlements: { free: { upstreams: ["docs"], rpm: 30 } } }),
    (error: unknown) => error instanceof ConfigError && /plain URI prefixes/.test(error.message),
  );
  assert.doesNotThrow(() => parseConfig({ ...base, entitlements: { free: { upstreams: ["docs"], rpm: 30, resources: { docs: ["docs://public/guides/"] } } } }));
  assert.doesNotThrow(() => parseConfig({ ...base, entitlements: { free: { upstreams: ["docs"], rpm: 30, resources: { docs: [] } } } }));
});

void test("the shipped example config routes resources only on the illustrative upstream, not JobScout", () => {
  const text = readFileSync(new URL("../../examples/gateway.example.yaml", import.meta.url), "utf8");
  const config = parseConfigYaml(text);
  // JobScout exposes no resources (jobscout-mcp main, src/server.ts), so the example must not claim any.
  assert.equal(config.upstreams.jobscout?.resources_allow, undefined);
  const sourcePack = config.upstreams.source_pack;
  assert.ok(sourcePack?.resources_allow && sourcePack.resources_allow.length > 0, "example shows resources_allow on source_pack");
});
