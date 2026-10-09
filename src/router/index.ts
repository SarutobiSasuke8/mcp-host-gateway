import type { UpstreamConfig } from "../config.js";
import type { JsonRpcId } from "../edge/errors.js";
import { forbidden, invalidRequest, methodNotFound, upstreamUnavailable } from "../edge/errors.js";
import type { Grant } from "../entitlement/index.js";
import { resourceAllowed } from "../entitlement/index.js";
import type { EntitlementMap } from "../entitlement/index.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

/**
 * Methods the gateway will forward. Everything else is refused before it reaches an upstream.
 * `prompts/*` is only routed for an upstream that has a `prompts_allow` list, and `resources/*`
 * only for one with a `resources_allow` list (see authoriseRequest). `resources/subscribe` and
 * `resources/unsubscribe` are never routed: the gateway relays no server-initiated stream.
 */
export const ROUTED_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "prompts/list",
  "prompts/get",
  "resources/list",
  "resources/templates/list",
  "resources/read",
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
  /**
   * A buffered body (JSON answers, which are one message), or a byte stream relayed to the client
   * as it arrives (SSE answers). Iterating the stream throws if the upstream fails or the call is
   * aborted mid-stream.
   */
  body: Uint8Array | string | AsyncIterable<Uint8Array>;
  /** True when `body` is a live stream. */
  streamed: boolean;
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
  // Likewise resources/*: without resources_allow the methods do not exist, and a read outside the
  // granted prefixes is forbidden in the same shape as a tool outside the plan.
  if (request.method.startsWith("resources/") && !grant.resourcesRouted) throw methodNotFound(request.method);
  if (request.method === "tools/call") entitlements.assertTool(grant, requireName(request));
  if (request.method === "prompts/get") entitlements.assertPrompt(grant, requireName(request));
  if (request.method === "resources/read") entitlements.assertResource(grant, requireParam(request, "uri"));
}

function requireParam(request: JsonRpcRequest, key: "name" | "uri"): string {
  const params = request.params;
  const value = params && typeof params === "object" ? (params as Record<string, unknown>)[key] : undefined;
  if (typeof value !== "string" || value.length === 0) throw invalidRequest(`${request.method} requires params.${key}`);
  return value;
}

function requireName(request: JsonRpcRequest): string {
  return requireParam(request, "name");
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

function filterUriList(
  payload: unknown,
  key: "resources" | "resourceTemplates",
  uriKey: "uri" | "uriTemplate",
  keep: (uri: string) => boolean,
): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const message = payload as { result?: Record<string, unknown> };
  const list = message.result?.[key];
  if (!message.result || !Array.isArray(list)) return payload;
  return {
    ...message,
    result: {
      ...message.result,
      [key]: (list as Array<Record<string, unknown> | null>).filter((item) => {
        const uri = item?.[uriKey];
        return typeof uri === "string" && keep(uri);
      }),
    },
  };
}

/** Drop resources whose URI is outside every granted prefix. Unknown shapes pass through untouched. */
export function filterResourcesList(payload: unknown, grant: Grant): unknown {
  return filterUriList(payload, "resources", "uri", (uri) => resourceAllowed(grant.resources, uri));
}

/**
 * Drop resource templates that could expand outside the granted prefixes. A template is kept
 * only when its literal head (everything before the first `{`) starts with a granted prefix, so
 * every expansion of a kept template starts with that prefix too. Reads are still checked one
 * by one. Unknown shapes pass through untouched.
 */
export function filterResourceTemplatesList(payload: unknown, grant: Grant): unknown {
  return filterUriList(payload, "resourceTemplates", "uriTemplate", (template) => {
    const brace = template.indexOf("{");
    const head = brace === -1 ? template : template.slice(0, brace);
    return resourceAllowed(grant.resources, head);
  });
}

/**
 * Rewrite an initialize result so `capabilities` only advertises what the gateway routes for
 * this caller: `tools` (when the upstream offers it), `prompts` (only when the caller's grant
 * has at least one prompt) and `resources` (only when the grant has at least one prefix, and
 * never with `subscribe`, which the gateway does not route). `completions`, `logging`,
 * `experimental` and any capability the gateway does not know are dropped. Unknown shapes are
 * passed through untouched.
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
    if (caps.resources !== undefined && grant.resources.length > 0) capabilities.resources = withoutSubscribe(caps.resources);
  }
  return { ...message, result: { ...message.result, capabilities } };
}

function withoutSubscribe(resources: unknown): unknown {
  if (!resources || typeof resources !== "object") return resources;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resources as Record<string, unknown>)) {
    if (key !== "subscribe") kept[key] = value;
  }
  return kept;
}

/** Result reshapers for the methods whose answers depend on the caller's grant. */
export const RESHAPERS: Readonly<Record<string, (payload: unknown, grant: Grant) => unknown>> = {
  initialize: filterInitializeResult,
  "tools/list": filterToolsList,
  "prompts/list": filterPromptsList,
  "resources/list": filterResourcesList,
  "resources/templates/list": filterResourceTemplatesList,
};

/**
 * Relay a text/event-stream body event by event. Events whose data is a JSON-RPC response with a
 * `result` are passed through `transform`; every other event (progress and other notifications,
 * comments, keep-alives) is relayed byte for byte as soon as it is complete. Without a transform
 * the bytes are relayed exactly as they arrive, with no parsing at all.
 */
export async function* relaySse(
  source: AsyncIterable<Uint8Array>,
  transform?: (message: unknown) => unknown,
): AsyncGenerator<Uint8Array> {
  if (!transform) {
    for await (const chunk of source) yield chunk;
    return;
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const boundary = /\r?\n\r?\n/;
  let buffer = "";
  const emit = (block: string): Uint8Array => encoder.encode(rewriteSseEvent(block, transform) + "\n\n");
  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    let match = boundary.exec(buffer);
    while (match) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      yield emit(block);
      match = boundary.exec(buffer);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) yield emit(buffer);
}

function rewriteSseEvent(block: string, transform: (message: unknown) => unknown): string {
  const lines = block.split(/\r?\n/);
  const dataLines = lines.filter((line) => line.startsWith("data:"));
  if (dataLines.length === 0) return block;
  let message: unknown;
  try {
    message = JSON.parse(dataLines.map((line) => line.slice(5).replace(/^ /, "")).join("\n"));
  } catch {
    return block;
  }
  if (!message || typeof message !== "object" || !("result" in message)) return block;
  const kept = lines.filter((line) => !line.startsWith("data:"));
  return [...kept, `data: ${JSON.stringify(transform(message))}`].join("\n");
}

async function* readBody(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    // Cancels the upstream body if the consumer stops early (client gone, error).
    await reader.cancel().catch(() => undefined);
  }
}

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

/** Map an abort to a reason, or undefined when the error was not an abort. */
function abortReason(error: unknown, timeout: AbortSignal, signal: AbortSignal | undefined): string | undefined {
  if (signal?.aborted) return "client disconnected";
  if (timeout.aborted || (error as Error | undefined)?.name === "TimeoutError") return "timed out";
  return undefined;
}

/** Re-throw mid-stream failures as the gateway's upstream error so the edge can audit them. */
async function* guardStream(
  stream: AsyncIterable<Uint8Array>,
  upstreamName: string,
  timeout: AbortSignal,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  try {
    yield* stream;
  } catch (error) {
    throw upstreamUnavailable(upstreamName, abortReason(error, timeout, signal) ?? "stream failed");
  }
}

export class Router {
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: RouterOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.env = options.env ?? process.env;
  }

  /**
   * Forward one JSON-RPC message. `signal` aborts the upstream request (the edge fires it when the
   * client disconnects); the upstream's `timeout_ms` caps the whole exchange, streaming included.
   */
  async forward(
    upstreamName: string,
    upstream: UpstreamConfig,
    grant: Grant,
    request: JsonRpcRequest,
    headers: ForwardHeaders,
    signal?: AbortSignal,
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

    const timeout = AbortSignal.timeout(upstream.timeout_ms);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(upstream.url, {
        method: "POST",
        headers: outbound,
        body: JSON.stringify(request),
        signal: combined,
      });
    } catch (error) {
      throw upstreamUnavailable(upstreamName, abortReason(error, timeout, signal) ?? "connection failed");
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const sessionId = response.headers.get("mcp-session-id") ?? undefined;

    if (response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      throw upstreamUnavailable(upstreamName, `HTTP ${response.status}`);
    }

    const reshape = response.status === 200 ? RESHAPERS[request.method] : undefined;

    // SSE answers are relayed as they arrive. For initialize and the list methods the final
    // result event is re-shaped to the grant on the way through.
    if (contentType.includes("text/event-stream") && response.body) {
      const stream = relaySse(readBody(response.body), reshape ? (message) => reshape(message, grant) : undefined);
      const result: ForwardResult = { status: response.status, contentType: "text/event-stream", body: guardStream(stream, upstreamName, timeout, signal), streamed: true };
      if (sessionId) result.sessionId = sessionId;
      return result;
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw upstreamUnavailable(upstreamName, abortReason(error, timeout, signal) ?? "response body failed");
    }
    const result: ForwardResult = { status: response.status, contentType, body: bytes, streamed: false };
    if (sessionId) result.sessionId = sessionId;
    if (!reshape) return result;

    if (contentType.includes("application/json")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw upstreamUnavailable(upstreamName, `${request.method} response was not JSON`);
      }
      return { ...result, contentType: "application/json", body: JSON.stringify(reshape(parsed, grant)) };
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
