import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { GatewayConfig } from "../src/config.js";
import { parseConfig } from "../src/config.js";
import { parseSseJson } from "../src/router/index.js";

export const STUB_TOOLS = [
  { name: "search_jobs", description: "Search", inputSchema: { type: "object" } },
  { name: "get_listing", description: "Get", inputSchema: { type: "object" } },
  { name: "admin_purge", description: "Dangerous", inputSchema: { type: "object" } },
];

export const STUB_PROMPTS = [
  { name: "setup", description: "Onboarding" },
  { name: "find_jobs", description: "Guided search", arguments: [{ name: "role", required: false }] },
  { name: "internal_debug", description: "Never exposed" },
];

/** Everything a full-featured upstream might advertise, including capabilities the gateway refuses. */
export const FULL_CAPABILITIES = {
  tools: { listChanged: false },
  prompts: { listChanged: false },
  resources: { subscribe: true },
  completions: {},
  logging: {},
  experimental: { anything: {} },
};

export interface StubUpstream {
  url: string;
  received: Array<{ method: string; headers: Record<string, string | string[] | undefined>; body: unknown }>;
  close(): Promise<void>;
}

/**
 * In-process Streamable HTTP MCP stub. Answers initialize, ping, tools/list and tools/call with
 * JSON responses, and records every request so tests can assert on what the gateway forwarded.
 * With `sse: true` it frames the tools/list response as text/event-stream.
 */
export async function startStubUpstream(
  options: { sse?: boolean; status?: number; capabilities?: Record<string, unknown> } = {},
): Promise<StubUpstream> {
  const received: StubUpstream["received"] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const body: unknown = text ? JSON.parse(text) : null;
      received.push({ method: req.method ?? "", headers: req.headers, body });
      if (req.method === "DELETE") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (options.status && options.status !== 200) {
        res.writeHead(options.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "upstream says no" }));
        return;
      }
      const message = body as { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } };
      let result: unknown;
      switch (message.method) {
        case "initialize":
          result = {
            protocolVersion: "2025-06-18",
            capabilities: options.capabilities ?? { tools: {} },
            serverInfo: { name: "stub", version: "0" },
          };
          break;
        case "prompts/list":
          result = { prompts: STUB_PROMPTS };
          break;
        case "prompts/get":
          result = { messages: [{ role: "user", content: { type: "text", text: `prompt ${message.params?.name}` } }] };
          break;
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = { tools: STUB_TOOLS };
          break;
        case "tools/call":
          result = { content: [{ type: "text", text: `called ${message.params?.name} with ${JSON.stringify(message.params?.arguments ?? {})}` }] };
          break;
        default:
          res.writeHead(202);
          res.end();
          return;
      }
      const reply = { jsonrpc: "2.0", id: message.id ?? null, result };
      if (options.sse && (message.method === "tools/list" || message.method === "initialize" || message.method === "prompts/list")) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Mcp-Session-Id": "stub-session" });
        res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "stub-session" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    received,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

export const FREE_TOKEN = "test-free-token-0123456789";
export const PAID_TOKEN = "test-paid-token-0123456789";
export const STATIC_TOKENS_ENV = `${FREE_TOKEN}:user-free:free,${PAID_TOKEN}:user-paid:paid`;

export function staticConfig(upstreamUrl: string, overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return parseConfig({
    version: 1,
    listen: { host: "127.0.0.1", port: 0 },
    auth: { mode: "static", tokens_env: "GATEWAY_STATIC_TOKENS" },
    upstreams: {
      jobscout: { url: upstreamUrl, tools_allow: ["search_jobs", "get_listing"] },
      source_pack: { url: upstreamUrl, tools_allow: ["search_jobs"] },
    },
    entitlements: {
      free: { upstreams: ["jobscout"], rpm: 3, tools: { jobscout: ["search_jobs"] } },
      paid: { upstreams: ["jobscout", "source_pack"], rpm: 300 },
    },
    ...overrides,
  });
}

export async function rpc(
  baseUrl: string,
  upstream: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; json: unknown }> {
  const response = await fetch(`${baseUrl}/mcp/${upstream}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown;
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    // Streamed answer: the JSON-RPC response is the event carrying a result or an error.
    const messages = parseSseJson(text);
    json = messages.find((m) => !!m && typeof m === "object" && ("result" in m || "error" in m)) ?? text;
  } else {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: response.status, headers: response.headers, json };
}

export const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
