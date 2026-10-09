import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import type { AuditConfig } from "./config.js";
import type { LogSink } from "./log.js";
import { redactString } from "./log.js";

/**
 * Structured audit trail: exactly one JSON line per routed call (every request to
 * `/mcp/<upstream>`, allowed or not). Separate from the operational log on stdout.
 *
 * Schema (every key is always present, in this order; absent values are null):
 *
 * | key         | type            | meaning |
 * | ----------- | --------------- | ------- |
 * | ts          | string          | ISO 8601 time the call finished |
 * | request_id  | string          | Gateway-generated UUID, also returned as `X-Request-Id` |
 * | subject     | string or null  | Authenticated identity; null when authentication failed |
 * | plan        | string or null  | Plan name once resolved |
 * | upstream    | string          | Upstream path segment from `/mcp/<upstream>` |
 * | method      | string or null  | JSON-RPC method, or `HTTP DELETE` for session end; null if the body never parsed |
 * | tool        | string or null  | `params.name` of a `tools/call` |
 * | prompt      | string or null  | `params.name` of a `prompts/get` |
 * | resource    | string or null  | `params.uri` of a `resources/read` |
 * | decision    | string          | `allow`, `deny`, `rate_limited` or `upstream_error` |
 * | reason      | string or null  | Why a call was not allowed, or `client_disconnected` |
 * | status      | integer         | HTTP status returned (499 when the client went away mid-stream) |
 * | duration_ms | integer         | Wall time from request start to response end |
 *
 * Never written: request or response bodies, tool arguments, prompt arguments, tool results, resource contents,
 * headers, bearer tokens, upstream credentials, client IP addresses. String fields are passed
 * through the same redaction as the operational log and capped in length as a second guard.
 */
export type AuditDecision = "allow" | "deny" | "rate_limited" | "upstream_error";

export interface AuditEntry {
  request_id: string;
  subject: string | null;
  plan: string | null;
  upstream: string;
  method: string | null;
  tool: string | null;
  prompt: string | null;
  resource: string | null;
  decision: AuditDecision;
  reason: string | null;
  status: number;
  duration_ms: number;
}

export const AUDIT_KEYS = [
  "ts",
  "request_id",
  "subject",
  "plan",
  "upstream",
  "method",
  "tool",
  "prompt",
  "resource",
  "decision",
  "reason",
  "status",
  "duration_ms",
] as const;

const MAX_FIELD = 256;

function clean(value: string | null): string | null {
  if (value === null) return null;
  const redacted = redactString(value);
  return redacted.length > MAX_FIELD ? `${redacted.slice(0, MAX_FIELD)}...` : redacted;
}

export class AuditLog {
  private readonly sink: LogSink;
  private readonly onClose: (() => void) | undefined;

  constructor(sink: LogSink, onClose?: () => void) {
    this.sink = sink;
    this.onClose = onClose;
  }

  record(entry: AuditEntry): void {
    const line = {
      ts: new Date().toISOString(),
      request_id: entry.request_id,
      subject: clean(entry.subject),
      plan: clean(entry.plan),
      upstream: clean(entry.upstream),
      method: clean(entry.method),
      tool: clean(entry.tool),
      prompt: clean(entry.prompt),
      resource: clean(entry.resource),
      decision: entry.decision,
      reason: clean(entry.reason),
      status: entry.status,
      duration_ms: Math.max(0, Math.round(entry.duration_ms)),
    };
    this.sink.write(JSON.stringify(line));
  }

  close(): void {
    this.onClose?.();
  }
}

/** Build the audit sink named in config. File sinks append, so several processes can share one file. */
export function createAuditLog(config: AuditConfig): AuditLog {
  if (config.sink === "file") {
    mkdirSync(dirname(config.path), { recursive: true });
    const fd = openSync(config.path, "a", 0o600);
    let open = true;
    return new AuditLog(
      { write: (line) => { if (open) writeSync(fd, line + "\n"); } },
      () => {
        if (open) {
          open = false;
          closeSync(fd);
        }
      },
    );
  }
  return new AuditLog({ write: (line) => process.stderr.write(line + "\n") });
}

export const silentAudit = new AuditLog({ write: () => undefined });
