import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Authenticator, Identity } from "../auth/index.js";
import { createAuthenticator } from "../auth/index.js";
import type { GatewayConfig } from "../config.js";
import { EntitlementMap } from "../entitlement/index.js";
import type { Logger } from "../log.js";
import { Logger as DefaultLogger } from "../log.js";
import { TokenBucketLimiter } from "../rate/index.js";
import { Router, authoriseRequest, parseJsonRpc } from "../router/index.js";
import type { JsonRpcRequest } from "../router/index.js";
import { GatewayError, invalidRequest, methodNotFound } from "./errors.js";
import type { JsonRpcId } from "./errors.js";

const MAX_BODY_BYTES = 1_048_576;
const MCP_PATH = /^\/mcp\/([a-z0-9_-]+)\/?$/;

export interface GatewayOptions {
  logger?: Logger;
  authenticator?: Authenticator;
  router?: Router;
  limiter?: TokenBucketLimiter;
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

function sendError(res: ServerResponse, error: GatewayError, id: JsonRpcId): void {
  sendJson(res, error.httpStatus, error.toJsonRpc(id), error.headers);
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

export function createGateway(config: GatewayConfig, options: GatewayOptions = {}): Gateway {
  const logger = options.logger ?? new DefaultLogger();
  const env = options.env ?? process.env;
  const authenticator = options.authenticator ?? createAuthenticator(config.auth, env);
  const entitlements = new EntitlementMap(config);
  const limiter = options.limiter ?? new TokenBucketLimiter();
  const router = options.router ?? new Router({ env });
  let ready = false;

  const rateKey = (identity: Identity, upstream: string): string =>
    config.rate.scope === "identity_upstream" ? `${identity.subject}\u0000${upstream}` : identity.subject;

  async function handleMcp(req: IncomingMessage, res: ServerResponse, upstreamName: string): Promise<void> {
    const started = Date.now();
    let requestId: JsonRpcId = null;
    let identity: Identity | undefined;
    let request: JsonRpcRequest | undefined;
    try {
      const upstream = config.upstreams[upstreamName];
      if (!upstream) throw methodNotFound(`/mcp/${upstreamName}`);

      if (req.method !== "POST" && req.method !== "DELETE") {
        // GET would open a server-initiated SSE stream. Not supported in v0 (see README).
        res.writeHead(405, { Allow: "POST, DELETE", "Content-Type": "application/json" });
        res.end(JSON.stringify(invalidRequest(`${req.method} is not supported; use POST`).toJsonRpc(null)));
        return;
      }

      identity = await authenticator.authenticate(headerValue(req, "authorization"));
      const grant = entitlements.grant(identity, upstreamName);
      const decision = limiter.enforce(rateKey(identity, upstreamName), grant.rpm);
      res.setHeader("X-RateLimit-Limit", String(grant.rpm));
      res.setHeader("X-RateLimit-Remaining", String(decision.remaining));

      const sessionId = headerValue(req, "mcp-session-id");

      if (req.method === "DELETE") {
        if (!sessionId) throw invalidRequest("DELETE requires Mcp-Session-Id");
        const status = await router.terminate(upstreamName, upstream, sessionId);
        res.writeHead(status);
        res.end();
        logger.info("session terminated", { upstream: upstreamName, subject: identity.subject, status });
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
      requestId = request.id ?? null;
      authoriseRequest(entitlements, grant, request);

      const forwardHeaders: Parameters<Router["forward"]>[4] = {};
      if (sessionId) forwardHeaders.sessionId = sessionId;
      const protocolVersion = headerValue(req, "mcp-protocol-version");
      if (protocolVersion) forwardHeaders.protocolVersion = protocolVersion;
      const accept = headerValue(req, "accept");
      if (accept) forwardHeaders.accept = accept;

      const result = await router.forward(upstreamName, upstream, grant, request, forwardHeaders);
      const headers: Record<string, string> = { "Content-Type": result.contentType };
      if (result.sessionId) headers["Mcp-Session-Id"] = result.sessionId;
      res.writeHead(result.status, headers);
      res.end(result.body);
      logger.info("forwarded", {
        upstream: upstreamName,
        subject: identity.subject,
        plan: grant.plan,
        method: request.method,
        status: result.status,
        ms: Date.now() - started,
      });
    } catch (error) {
      if (error instanceof GatewayError) {
        logger.warn("rejected", {
          upstream: upstreamName,
          subject: identity?.subject,
          method: request?.method,
          code: error.code,
          status: error.httpStatus,
          reason: error.message,
        });
        sendError(res, error, requestId);
        return;
      }
      logger.error("unhandled", { upstream: upstreamName, error: (error as Error).message });
      sendError(res, new GatewayError(-32002, 502, "Gateway error"), requestId);
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
        upstreams: Object.keys(config.upstreams),
        plans: Object.keys(config.entitlements),
      });
      return port;
    },
    async stop() {
      ready = false;
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
