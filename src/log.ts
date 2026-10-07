/**
 * Structured JSON-line logger with secret redaction.
 *
 * Anything that looks like a bearer token, an Authorization header, a JWT, or a value under a
 * secret-shaped key is replaced before it reaches stdout. The gateway never logs request or
 * response bodies, only method names, upstream names, identity subjects and outcomes.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogSink {
  write(line: string): void;
}

const SECRET_KEYS = /^(authorization|proxy-authorization|cookie|set-cookie|token|access_token|id_token|refresh_token|secret|password|api[_-]?key|.*_auth)$/i;
const BEARER_VALUE = /\b(bearer)\s+[a-z0-9._~+/=-]+/gi;
const JWT_VALUE = /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/gi;

export function redactString(value: string): string {
  return value.replace(BEARER_VALUE, "$1 [redacted]").replace(JWT_VALUE, "[redacted-jwt]");
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.test(key) ? "[redacted]" : redact(inner, depth + 1);
    }
    return out;
  }
  return value;
}

const levelRank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private readonly sink: LogSink;
  private readonly minLevel: LogLevel;

  constructor(options: { sink?: LogSink; level?: LogLevel } = {}) {
    this.sink = options.sink ?? { write: (line) => process.stdout.write(line + "\n") };
    this.minLevel = options.level ?? "info";
  }

  log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    if (levelRank[level] < levelRank[this.minLevel]) return;
    const entry = { ts: new Date().toISOString(), level, msg: redactString(msg), ...(redact(fields) as Record<string, unknown>) };
    this.sink.write(JSON.stringify(entry));
  }

  debug(msg: string, fields?: Record<string, unknown>): void { this.log("debug", msg, fields); }
  info(msg: string, fields?: Record<string, unknown>): void { this.log("info", msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>): void { this.log("warn", msg, fields); }
  error(msg: string, fields?: Record<string, unknown>): void { this.log("error", msg, fields); }
}

export const silentLogger = new Logger({ sink: { write: () => undefined }, level: "error" });
