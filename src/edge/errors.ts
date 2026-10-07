/**
 * MCP-facing errors. Every rejection the gateway makes is returned as a JSON-RPC 2.0 error
 * object so an MCP client can surface the reason rather than a bare HTTP status.
 *
 * Codes in the -32000..-32099 range are reserved for server-defined errors by JSON-RPC.
 */
export const ErrorCode = {
  Unauthenticated: -32001,
  UpstreamUnavailable: -32002,
  Forbidden: -32003,
  RateLimited: -32029,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  ParseError: -32700,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export type JsonRpcId = string | number | null;

export interface JsonRpcErrorBody {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: Record<string, unknown> };
}

export class GatewayError extends Error {
  override readonly name = "GatewayError";
  readonly code: ErrorCodeValue;
  readonly httpStatus: number;
  readonly data: Record<string, unknown> | undefined;
  readonly headers: Record<string, string>;

  constructor(
    code: ErrorCodeValue,
    httpStatus: number,
    message: string,
    options: { data?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.data = options.data;
    this.headers = options.headers ?? {};
  }

  toJsonRpc(id: JsonRpcId): JsonRpcErrorBody {
    const error: JsonRpcErrorBody["error"] = { code: this.code, message: this.message };
    if (this.data) error.data = this.data;
    return { jsonrpc: "2.0", id, error };
  }
}

export const unauthenticated = (reason: string): GatewayError =>
  new GatewayError(ErrorCode.Unauthenticated, 401, `Unauthenticated: ${reason}`, {
    headers: { "WWW-Authenticate": 'Bearer realm="mcp-host-gateway"' },
  });

export const forbidden = (reason: string, data?: Record<string, unknown>): GatewayError =>
  new GatewayError(ErrorCode.Forbidden, 403, `Forbidden: ${reason}`, data ? { data } : {});

export const rateLimited = (retryAfterSeconds: number, data?: Record<string, unknown>): GatewayError =>
  new GatewayError(ErrorCode.RateLimited, 429, "Rate limit exceeded for this identity; retry later", {
    headers: { "Retry-After": String(retryAfterSeconds) },
    ...(data ? { data } : {}),
  });

export const invalidRequest = (reason: string): GatewayError =>
  new GatewayError(ErrorCode.InvalidRequest, 400, `Invalid request: ${reason}`);

export const methodNotFound = (method: string): GatewayError =>
  new GatewayError(ErrorCode.MethodNotFound, 404, `Method not routed by this gateway: ${method}`, {
    data: { method },
  });

export const upstreamUnavailable = (upstream: string, reason: string): GatewayError =>
  new GatewayError(ErrorCode.UpstreamUnavailable, 502, `Upstream "${upstream}" unavailable: ${reason}`, {
    data: { upstream },
  });
