import type { UpstreamConfig } from "../config.js";
import type { JsonRpcId } from "../edge/errors.js";
import { forbidden, invalidRequest, methodNotFound, upstreamUnavailable } from "../edge/errors.js";
import type { Grant } from "../entitlement/index.js";
import type { EntitlementMap } from "../entitlement/index.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

/**
 * Methods the gateway will forward. Everything else is refused before it reaches an upstream.
 * `prompts/*` is only routed for an upstream that has a `prompts_allow` list (see authoriseRequest).
 */
export const ROUTED_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "prompts/list",
  "prompts/get",
  "notifications/initialized",
  "notifications/cancelled",
]);

export interface ForwardHeaders {
  sessionId?: string;
  protocolVersion?: string;
  accept?: string;
}

export interface ForwardResult {
  status: number;
  contentType: string;
  body: Uint8Array | string;
  sessionId?: string;
}

export interface RouterOptions {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export function parseJsonRpc(raw: unknown): JsonRpcRequest {
  if (Array.isArray(raw)) throw invalidRequest("JSON-RPC batches are not supported by this gateway");
  if (!raw || typeof raw !== "object") throw invalidRequest("body must be a JSON-RPC 2.0 object");
  const message = raw as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") throw invalidRequest('jsonrpc must be "2.0"');
  if (typeof message.method !== "string" || message.method.length === 0) throw invalidRequest("method is required");
  const id = message.id;
  if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") {
    throw invalidRequest("id must be a string, number or null");
  }
  const request: JsonRpcRequest = { jsonrpc: "2.0", method: message.method };
  if (id !== undefined) request.id = id as JsonRpcId;
  if ("params" in message) request.params = message.params;
  return request;
}

/**
 * Check a parsed request against the grant. Throws for methods the gateway does not route and
 * for tool calls outside the plan. Returns nothing: this is a pure policy check.
 */
export function authoriseRequest(entitlements: EntitlementMap, grant: Grant, request: JsonRpcRequest): void {
  if (!ROUTED_METHODS.has(request.method)) throw methodNotFound(request.method);
  // Deny by default: an upstream without prompts_allow does not route prompts/* at all, exactly
  // as before prompts were supported.
  if (request.method.startsWith("prompts/") && !grant.promptsRouted) throw methodNotFound(request.method);
  if (request.method === "tools/call") entitlements.assertTool(grant, requireName(request));
  if (request.method === "prompts/get") entitlements.assertPrompt(grant, requireName(request));
}

function requireName(request: JsonRpcRequest): string {
  const params = request.params;
  const name = params && typeof params === "object" ? (params as { name?: unknown }).name : undefined;
  if (typeof name !== "string" || name.length === 0) throw invalidRequest(`${request.method} requires params.name`);
  return name;
}

function filterNamedList(payload: unknown, key: "tools" | "prompts", allowed: ReadonlySet<string>): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const message = payload as { result?: Record<string, unknown> };
  const list = message.result?.[key];
  if (!message.result || !Array.isArray(list)) return payload;
  return {
    ...message,
    result: {
      ...message.result,
      [key]: (list as Array<{ name?: unknown } | null>).filter(
        (item) => !!item && typeof item.name === "string" && allowed.has(item.name),
      ),
    },
  };
}

/** Drop tools the plan does not grant. Unknown shapes are passed through untouched. */
export function filterToolsList(payload: unknown, grant: Grant): unknown {
  return filterNamedList(payload, "tools", grant.tools);
}

/** Drop prompts the plan does not grant. Unknown shapes are passed through untouched. */
export function filterPromptsList(payload: unknown, grant: Grant): unknown {
  return filterNamedList(payload, "prompts", grant.prompts);
}

/**
 * Rewrite an initialize result so `capabilities` only advertises what the gateway routes for
 * this caller: `tools` (when the upstream offers it) and `prompts` (only when the caller's grant
 * has at least one prompt). `resources`, `completions`, `logging`, `experimental` and any
 * capability the gateway does not know are dropped. Unknown shapes are passed through untouched.
 */
export function filterInitializeResult(payload: unknown, grant: Grant): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const message = payload as { result?: { capabilities?: unknown } };
  if (!message.result || typeof message.result !== "object") return payload;
  const offered = message.result.capabilities;
  const capabilities: Record<string, unknown> = {};
  if (offered && typeof offered === "object") {
    const caps = offered as Record<string, unknown>;
    if (caps.tools !== undefined) capabilities.tools = caps.tools;
    if (caps.prompts !== undefined && grant.prompts.size > 0) capabilities.prompts = caps.prompts;
  }
  return { ...message, result: { ...message.result, capabilities } };
}

/** Result reshapers for the methods whose answers depend on the caller's grant. */
export const RESHAPERS: Readonly<Record<string, (payload: unknown, grant: Grant) => unknown>> = {
  initialize: filterInitializeResult,
  "tools/list": filterToolsList,
  "prompts/list": filterPromptsList,
};

/** Parse a buffered text/event-stream body into its JSON data payloads. */
export function parseSseJson(text: string): unknown[] {
  const out: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // Not JSON; ignore.
    }
  }
  return out;
}

export class Router {
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: RouterOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.env = options.env ?? process.env;
  }

  async forward(
    upstreamName: string,
    upstream: UpstreamConfig,
    grant: Grant,
    request: JsonRpcRequest,
    headers: ForwardHeaders,
  ): Promise<ForwardResult> {
    const outbound = new Headers({
      "Content-Type": "application/json",
      Accept: headers.accept ?? "application/json, text/event-stream",
    });
    if (headers.sessionId) outbound.set("Mcp-Session-Id", headers.sessionId);
    if (headers.protocolVersion) outbound.set("MCP-Protocol-Version", headers.protocolVersion);
    if (upstream.auth_header_env) {
      const value = this.env[upstream.auth_header_env];
      if (!value) throw forbidden(`upstream "${upstreamName}" credential is not configured on the gateway`);
      outbound.set("Authorization", value);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(upstream.url, {
        method: "POST",
        headers: outbound,
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(upstream.timeout_ms),
      });
    } catch (error) {
      const reason = (error as Error).name === "TimeoutError" ? "timed out" : "connection failed";
      throw upstreamUnavailable(upstreamName, reason);
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const sessionId = response.headers.get("mcp-session-id") ?? undefined;
    const bytes = new Uint8Array(await response.arrayBuffer());

    if (response.status >= 500) throw upstreamUnavailable(upstreamName, `HTTP ${response.status}`);

    const result: ForwardResult = { status: response.status, contentType, body: bytes };
    if (sessionId) result.sessionId = sessionId;

    const reshape = RESHAPERS[request.method];
    if (!reshape || response.status !== 200) return result;

    // initialize, tools/list and prompts/list: re-shape the advertised surface to the grant,
    // whatever the transport framing.
    const text = new TextDecoder().decode(bytes);
    if (contentType.includes("application/json")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw upstreamUnavailable(upstreamName, `${request.method} response was not JSON`);
      }
      return { ...result, contentType: "application/json", body: JSON.stringify(reshape(parsed, grant)) };
    }
    if (contentType.includes("text/event-stream")) {
      const messages = parseSseJson(text);
      const reply = messages.find((m) => m && typeof m === "object" && "result" in (m as object));
      if (!reply) throw upstreamUnavailable(upstreamName, `${request.method} stream carried no result`);
      return { ...result, contentType: "application/json", body: JSON.stringify(reshape(reply, grant)) };
    }
    throw upstreamUnavailable(upstreamName, `unexpected content type ${contentType}`);
  }

  /** Forward a session termination (HTTP DELETE) to the upstream. */
  async terminate(upstreamName: string, upstream: UpstreamConfig, sessionId: string): Promise<number> {
    const outbound = new Headers({ "Mcp-Session-Id": sessionId });
    if (upstream.auth_header_env) {
      const value = this.env[upstream.auth_header_env];
      if (value) outbound.set("Authorization", value);
    }
    try {
      const response = await this.fetchImpl(upstream.url, {
        method: "DELETE",
        headers: outbound,
        signal: AbortSignal.timeout(upstream.timeout_ms),
      });
      return response.status;
    } catch {
      throw upstreamUnavailable(upstreamName, "connection failed");
    }
  }
}
