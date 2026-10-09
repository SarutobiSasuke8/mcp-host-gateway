import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { AuditLog } from "../src/audit.js";
import { createGateway } from "../src/edge/server.js";
import type { Gateway } from "../src/edge/server.js";
import { silentLogger } from "../src/log.js";
import { TokenBucketLimiter } from "../src/rate/index.js";
import { parseSseJson } from "../src/router/index.js";
import { PAID_TOKEN, STATIC_TOKENS_ENV, STUB_TOOLS, bearer, staticConfig } from "./support.js";

/**
 * Upstream that answers every POST with an SSE stream: one progress notification straight away,
 * then nothing until the test calls `release()`, then the final result. It records whether the
 * upstream finished, and whether the gateway hung up on it before it could finish.
 */
interface SlowUpstream {
  url: string;
  finished: boolean;
  release(): void;
  /** Resolves true when the gateway closed the upstream connection before the result was sent. */
  aborted: Promise<boolean>;
  close(): Promise<void>;
}

async function startSlowUpstream(): Promise<SlowUpstream> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let markAborted!: (value: boolean) => void;
  const aborted = new Promise<boolean>((resolve) => (markAborted = resolve));
  const state = { finished: false };
  const sockets = new Set<ServerResponse>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string };
      sockets.add(res);
      res.on("close", () => {
        if (!state.finished) markAborted(true);
      });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "p1", progress: 1, total: 2 } })}\n\n`);
      void gate.then(() => {
        if (res.destroyed) return;
        const result = message.method === "tools/list" ? { tools: STUB_TOOLS } : { content: [{ type: "text", text: "done" }] };
        state.finished = true;
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
        markAborted(false);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    get finished() {
      return state.finished;
    },
    release,
    aborted,
    close: () =>
      new Promise<void>((resolve, reject) => {
        release();
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

async function gatewayFor(upstreamUrl: string, auditLines: string[] = []): Promise<{ gateway: Gateway; base: string }> {
  const gateway = createGateway(staticConfig(upstreamUrl), {
    logger: silentLogger,
    env: { GATEWAY_STATIC_TOKENS: STATIC_TOKENS_ENV },
    limiter: new TokenBucketLimiter(),
    audit: new AuditLog({ write: (line) => auditLines.push(line) }),
  });
  const port = await gateway.start();
  return { gateway, base: `http://127.0.0.1:${port}` };
}

function post(base: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const init: RequestInit = {
    method: "POST",
    headers: { ...bearer(PAID_TOKEN), "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  };
  if (signal) init.signal = signal;
  return fetch(`${base}/mcp/jobscout`, init);
}

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms))]);

void test("SSE tools/call is streamed: the first event reaches the client before the upstream finishes", async () => {
  const upstream = await startSlowUpstream();
  const { gateway, base } = await gatewayFor(upstream.url);
  try {
    const response = await post(base, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "get_listing", arguments: {} } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const first = await withTimeout(reader.read(), 5_000, "first event");
    const firstText = decoder.decode(first.value);
    assert.match(firstText, /notifications\/progress/);
    assert.equal(upstream.finished, false, "the upstream has not sent its result yet");

    upstream.release();
    let rest = "";
    for (;;) {
      const { done, value } = await withTimeout(reader.read(), 5_000, "rest of stream");
      if (done) break;
      rest += decoder.decode(value, { stream: true });
    }
    const messages = parseSseJson(firstText + rest);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[1], { jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "done" }] } });
  } finally {
    await gateway.stop();
    await upstream.close();
  }
});

void test("streamed tools/list still has its final result filtered to the grant", async () => {
  const upstream = await startSlowUpstream();
  const { gateway, base } = await gatewayFor(upstream.url);
  try {
    // Free plan is narrowed to search_jobs; use the free token for this one.
    const response = await fetch(`${base}/mcp/jobscout`, {
      method: "POST",
      headers: { Authorization: "Bearer test-free-token-0123456789", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    const reader = response.body!.getReader();
    const first = await withTimeout(reader.read(), 5_000, "first event");
    assert.equal(upstream.finished, false);
    upstream.release();
    let text = new TextDecoder().decode(first.value);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    const final = parseSseJson(text).find((m) => !!m && typeof m === "object" && "result" in m) as { result: { tools: Array<{ name: string }> } };
    assert.deepEqual(final.result.tools.map((t) => t.name), ["search_jobs"]);
  } finally {
    await gateway.stop();
    await upstream.close();
  }
});

void test("client disconnect mid-stream aborts the upstream request and is audited", async () => {
  const upstream = await startSlowUpstream();
  const auditLines: string[] = [];
  const { gateway, base } = await gatewayFor(upstream.url, auditLines);
  try {
    const controller = new AbortController();
    const response = await post(base, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "get_listing", arguments: {} } }, controller.signal);
    const reader = response.body!.getReader();
    await withTimeout(reader.read(), 5_000, "first event");
    controller.abort();

    // The gateway must hang up on the upstream, long before anyone releases it.
    assert.equal(await withTimeout(upstream.aborted, 5_000, "upstream abort"), true);
    assert.equal(upstream.finished, false);

    await withTimeout(
      (async () => {
        while (auditLines.length === 0) await new Promise((r) => setTimeout(r, 20));
      })(),
      5_000,
      "audit line",
    );
    const entry = JSON.parse(auditLines[0]!) as Record<string, unknown>;
    assert.equal(entry.status, 499);
    assert.equal(entry.reason, "client_disconnected");
    assert.equal(entry.tool, "get_listing");
  } finally {
    await gateway.stop();
    await upstream.close();
  }
});
