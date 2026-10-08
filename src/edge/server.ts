import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { AuditDecision, AuditLog } from "../audit.js";
import { createAuditLog } from "../audit.js";
import type { Authenticator, Identity } from "../auth/index.js";
import { createAuthenticator } from "../auth/index.js";
import type { GatewayConfig } from "../config.js";
import type { Grant } from "../entitlement/index.js";
import { EntitlementMap } from "../entitlement/index.js";
import type { Logger } from "../log.js";
import { Logger as DefaultLogger } from "../log.js";
import type { RateStore } from "../rate/index.js";
import { TokenBucketLimiter, enforceRate } from "../rate/index.js";
import { SqliteRateStore } from "../rate/sqlite.js";
import { Router, authoriseRequest, parseJsonRpc } from "../router/index.js";
import type { JsonRpcRequest } from "../router/index.js";
import { ErrorCode, GatewayError, invalidRequest, methodNotFound } from "./errors.js";
import type { JsonRpcId } from "./errors.js";

const MAX_BODY_BYTES = 1_048_576;
const MCP_PATH = /^\/mcp\/([a-z0-9_-]+)\/?$/;
/** Status recorded when the client goes away before the response is complete (nginx convention). */
export const CLIENT_CLOSED_STATUS = 499;

export interface GatewayOptions {
  logger?: Logger;
  authenticator?: Authenticator;
  router?: Router;
  /** Rate store. Defaults to the store named in `config.rate.store`. */
  limiter?: RateStore;
  /** Audit trail. Defaults to the sink named in `config.audit`. */
  audit?: AuditLog;
  env?: NodeJS.ProcessEnv;
}

export interface Gateway {
  readonly server: Server;
  readonly config: GatewayConfig;
  /** Run startup probes (fail closed), then listen. Resolves with the bound port. */
  start(): Promise<number>;
  stop(): Promise<void>;
  isReady(): boolean;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw invalidRequest(`body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function paramName(request: JsonRpcRequest | undefined, method: string): string | null {
  if (!request || request.method !== method) return null;
  const params = request.params;
  const name = params && typeof params === "object" ? (params as { name?: unknown }).name : undefined;
  return typeof name === "string" ? name : null;
}

function decisionFor(error: GatewayError): AuditDecision {
  if (error.code === ErrorCode.RateLimited) return "rate_limited";
  if (error.code === ErrorCode.UpstreamUnavailable) return "upstream_error";
  return "deny";
}

function isStream(body: unknown): body is AsyncIterable<Uint8Array> {
  return !!body && typeof body === "object" && Symbol.asyncIterator in body;
}

/** Build the rate store named in config. */
export function createRateStore(config: GatewayConfig["rate"]): RateStore {
  return config.store === "sqlite" ? new SqliteRateStore(config.sqlite_path) : new TokenBucketLimiter();
}

export function createGateway(config: GatewayConfig, options: GatewayOptions = {}): Gateway {
  const logger = options.logger ?? new DefaultLogger();
  const env = options.env ?? process.env;
  const authenticator = options.authenticator ?? createAuthenticator(config.auth, env);
  const entitlements = new EntitlementMap(config);
  const ownsLimiter = !options.limiter;
  const limiter = options.limiter ?? createRateStore(config.rate);
  const ownsAudit = !options.audit;
  const audit = options.audit ?? createAuditLog(config.audit);
  const router = options.router ?? new Router({ env });
  let ready = false;

  const rateKey = (identity: Identity, upstream: string): string =>
    config.rate.scope === "identity_upstream" ? `${identity.subject}\u0000${upstream}` : identity.subject;

  async function handleMcp(req: IncomingMessage, res: ServerResponse, upstreamName: string): Promise<void> {
    const started = Date.now();
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);
    let rpcId: JsonRpcId = null;
    let identity: Identity | undefined;
    let grant: Grant | undefined;
    let request: JsonRpcRequest | undefined;
    let method: string | null = null;

    // A client that goes away aborts the upstream call, streaming or not.
    const disconnect = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) disconnect.abort(new Error("client disconnected"));
    });

    const record = (decision: AuditDecision, status: number, reason: string | null): void => {
      audit.record({
        request_id: requestId,
        subject: identity?.subject ?? null,
        plan: grant?.plan ?? null,
        upstream: upstreamName,
        method,
        tool: paramName(request, "tools/call"),
        prompt: paramName(request, "prompts/get"),
        decision,
        reason,
        status,
        duration_ms: Date.now() - started,
      });
    };

    try {
      const upstream = config.upstreams[upstreamName];
      if (!upstream) throw methodNotFound(`/mcp/${upstreamName}`);

      if (req.method !== "POST" && req.method !== "DELETE") {
        // GET would open a server-initiated SSE stream. Not supported (see README).
        const error = invalidRequest(`${req.method} is not supported; use POST`);
        res.writeHead(405, { Allow: "POST, DELETE", "Content-Type": "application/json" });
        res.end(JSON.stringify(error.toJsonRpc(null)));
        method = `HTTP ${req.method ?? "UNKNOWN"}`;
        record("deny", 405, error.message);
        return;
      }

      identity = await authenticator.authenticate(headerValue(req, "authorization"));
      grant = entitlements.grant(identity, upstreamName);
      const sessionId = headerValue(req, "mcp-session-id");

      if (req.method === "DELETE") {
        method = "HTTP DELETE";
        const decision = await enforceRate(limiter, rateKey(identity, upstreamName), grant.rpm);
        res.setHeader("X-RateLimit-Limit", String(grant.rpm));
        res.setHeader("X-RateLimit-Remaining", String(decision.remaining));
        if (!sessionId) throw invalidRequest("DELETE requires Mcp-Session-Id");
        const status = await router.terminate(upstreamName, upstream, sessionId);
        res.writeHead(status);
        res.end();
        logger.info("session terminated", { upstream: upstreamName, subject: identity.subject, status });
        record("allow", status, null);
        return;
      }

      const contentType = headerValue(req, "content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        throw invalidRequest("Content-Type must be application/json");
      }
      let raw: unknown;
      try {
        raw = JSON.parse(await readBody(req));
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw invalidRequest("body is not valid JSON");
      }
      request = parseJsonRpc(raw);
      rpcId = request.id ?? null;
      method = request.method;

      // Every authenticated call counts against the quota, including ones refused below.
      const decision = await enforceRate(limiter, rateKey(identity, upstreamName), grant.rpm);
      res.setHeader("X-RateLimit-Limit", String(grant.rpm));
      res.setHeader("X-RateLimit-Remaining", String(decision.remaining));

      authoriseRequest(entitlements, grant, request);

      const forwardHeaders: Parameters<Router["forward"]>[4] = {};
      if (sessionId) forwardHeaders.sessionId = sessionId;
      const protocolVersion = headerValue(req, "mcp-protocol-version");
      if (protocolVersion) forwardHeaders.protocolVersion = protocolVersion;
      const accept = headerValue(req, "accept");
      if (accept) forwardHeaders.accept = accept;

      const result = await router.forward(upstreamName, upstream, grant, request, forwardHeaders, disconnect.signal);
      const headers: Record<string, string> = { "Content-Type": result.contentType };
      if (result.sessionId) headers["Mcp-Session-Id"] = result.sessionId;

      if (isStream(result.body)) {
        headers["Cache-Control"] = "no-cache";
        headers["X-Accel-Buffering"] = "no";
        res.writeHead(result.status, headers);
        res.flushHeaders();
        try {
          for await (const chunk of result.body) {
            if (!res.write(chunk)) await once(res, "drain", { signal: disconnect.signal });
          }
        } catch (error) {
          // Headers are gone; all we can do is end the stream and record why.
          const reason = disconnect.signal.aborted
            ? "client_disconnected"
            : error instanceof GatewayError
              ? error.message
              : "stream failed";
          if (!res.writableEnded) res.end();
          if (disconnect.signal.aborted) record("allow", CLIENT_CLOSED_STATUS, reason);
          else record("upstream_error", result.status, reason);
          logger.warn("stream ended early", { upstream: upstreamName, subject: identity.subject, method, reason });
          return;
        }
        res.end();
      } else {
        res.writeHead(result.status, headers);
        res.end(result.body);
      }
      logger.info("forwarded", {
        upstream: upstreamName,
        subject: identity.subject,
        plan: grant.plan,
        method: request.method,
        status: result.status,
        streamed: result.streamed,
        ms: Date.now() - started,
      });
      record("allow", result.status, null);
    } catch (error) {
      const gatewayError =
        error instanceof GatewayError ? error : new GatewayError(ErrorCode.UpstreamUnavailable, 502, "Gateway error");
      if (error instanceof GatewayError) {
        logger.warn("rejected", {
          upstream: upstreamName,
          subject: identity?.subject,
          method: request?.method,
          code: error.code,
          status: error.httpStatus,
          reason: error.message,
        });
      } else {
        logger.error("unhandled", { upstream: upstreamName, error: (error as Error).message });
      }
      const aborted = disconnect.signal.aborted;
      if (!res.headersSent && !aborted) sendJson(res, gatewayError.httpStatus, gatewayError.toJsonRpc(rpcId), gatewayError.headers);
      else if (!res.writableEnded) res.end();
      if (aborted) record("allow", CLIENT_CLOSED_STATUS, "client_disconnected");
      else record(decisionFor(gatewayError), gatewayError.httpStatus, gatewayError.message);
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/ready") {
      sendJson(res, ready ? 200 : 503, {
        status: ready ? "ready" : "not_ready",
        auth_mode: authenticator.mode,
        upstreams: Object.keys(config.upstreams).length,
      });
      return;
    }
    const match = MCP_PATH.exec(url.pathname);
    if (match && match[1]) {
      void handleMcp(req, res, match[1]);
      return;
    }
    sendJson(res, 404, { jsonrpc: "2.0", id: null, error: { code: -32601, message: "Not found" } });
  });

  return {
    server,
    config,
    isReady: () => ready,
    async start() {
      await authenticator.verifyStartup();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.listen.port, config.listen.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      ready = true;
      const { port } = server.address() as AddressInfo;
      logger.info("gateway listening", {
        host: config.listen.host,
        port,
        auth_mode: authenticator.mode,
        rate_store: limiter.kind,
        audit_sink: options.audit ? "custom" : config.audit.sink,
        upstreams: Object.keys(config.upstreams),
        plans: Object.keys(config.entitlements),
      });
      return port;
    },
    async stop() {
      ready = false;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      if (ownsLimiter) await limiter.close?.();
      if (ownsAudit) audit.close();
    },
  };
}
