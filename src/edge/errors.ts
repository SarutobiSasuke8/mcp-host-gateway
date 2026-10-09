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
  AuthUnavailable: -32004,
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

/** RFC 6750 error codes the gateway uses in a Bearer challenge. */
export type BearerErrorCode = "invalid_request" | "invalid_token";

export interface BearerChallenge {
  /**
   * RFC 9728 protected resource metadata URL. MCP clients read it from a 401 to find the
   * authorisation server (MCP authorisation spec, "Authorization Server Discovery").
   */
  resourceMetadata?: string | undefined;
  /** Omitted when the request carried no credentials at all (RFC 6750 section 3.1). */
  error?: BearerErrorCode | undefined;
  errorDescription?: string | undefined;
}

/** Quote an auth-param value: printable ASCII only, with backslash and double quote escaped. */
function quoteParam(value: string): string {
  return `"${value.replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

/** Build a `WWW-Authenticate: Bearer ...` value. */
export function bearerChallenge(challenge: BearerChallenge = {}): string {
  const params = [`realm=${quoteParam("mcp-host-gateway")}`];
  if (challenge.resourceMetadata) params.push(`resource_metadata=${quoteParam(challenge.resourceMetadata)}`);
  if (challenge.error) params.push(`error=${quoteParam(challenge.error)}`);
  if (challenge.error && challenge.errorDescription) params.push(`error_description=${quoteParam(challenge.errorDescription)}`);
  return `Bearer ${params.join(", ")}`;
}

/** 401 with a Bearer challenge. The reason doubles as the RFC 6750 error_description. */
export const unauthenticated = (reason: string, challenge: BearerChallenge = {}): GatewayError =>
  new GatewayError(ErrorCode.Unauthenticated, 401, `Unauthenticated: ${reason}`, {
    headers: { "WWW-Authenticate": bearerChallenge({ ...challenge, errorDescription: challenge.errorDescription ?? reason }) },
  });

/**
 * The token cannot be checked right now because the issuer's signing keys are unavailable. Not a
 * 401: the token may be fine, and a 401 would send the client back through sign-in for nothing.
 */
export const authUnavailable = (retryAfterSeconds: number): GatewayError =>
  new GatewayError(
    ErrorCode.AuthUnavailable,
    503,
    "Authentication temporarily unavailable: the token issuer cannot be reached; retry later",
    { headers: { "Retry-After": String(retryAfterSeconds) } },
  );

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
