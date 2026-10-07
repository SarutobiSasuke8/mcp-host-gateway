import assert from "node:assert/strict";
import test from "node:test";

import { Logger, redact, redactString } from "../src/log.js";

void test("redacts bearer tokens, JWTs and secret-shaped keys", () => {
  assert.equal(redactString("Authorization: Bearer abc.def-123"), "Authorization: Bearer [redacted]");
  const jwt = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
  assert.equal(redactString(`token=${jwt}`), "token=[redacted-jwt]");

  const out = redact({
    authorization: "Bearer x",
    nested: { api_key: "k", JOBSCOUT_UPSTREAM_AUTH: "Bearer y", ok: "fine" },
    list: ["Bearer z", 1],
  }) as Record<string, unknown>;
  assert.equal(out.authorization, "[redacted]");
  assert.deepEqual(out.nested, { api_key: "[redacted]", JOBSCOUT_UPSTREAM_AUTH: "[redacted]", ok: "fine" });
  assert.deepEqual(out.list, ["Bearer [redacted]", 1]);
});

void test("logger writes one JSON line per entry and honours the level", () => {
  const lines: string[] = [];
  const logger = new Logger({ sink: { write: (l) => lines.push(l) }, level: "info" });
  logger.debug("hidden");
  logger.info("shown", { token: "secret", subject: "alice" });
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(entry.level, "info");
  assert.equal(entry.msg, "shown");
  assert.equal(entry.token, "[redacted]");
  assert.equal(entry.subject, "alice");
});
