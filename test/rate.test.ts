import assert from "node:assert/strict";
import test from "node:test";

import { ErrorCode, GatewayError } from "../src/edge/errors.js";
import { TokenBucketLimiter } from "../src/rate/index.js";

void test("token bucket allows exactly rpm requests in a burst, then denies", () => {
  let now = 1_000_000;
  const limiter = new TokenBucketLimiter({ now: () => now });
  for (let i = 0; i < 5; i += 1) {
    const decision = limiter.take("alice", 5);
    assert.equal(decision.allowed, true, `request ${i + 1} should be allowed`);
    assert.equal(decision.remaining, 4 - i);
  }
  const denied = limiter.take("alice", 5);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSeconds >= 1);

  // Another identity has its own bucket.
  assert.equal(limiter.take("bob", 5).allowed, true);

  // Twelve seconds at 5 rpm refills one token.
  now += 12_000;
  assert.equal(limiter.take("alice", 5).allowed, true);
  assert.equal(limiter.take("alice", 5).allowed, false);

  // A full minute restores the whole bucket.
  now += 60_000;
  for (let i = 0; i < 5; i += 1) assert.equal(limiter.take("alice", 5).allowed, true);
  assert.equal(limiter.take("alice", 5).allowed, false);
});

void test("enforce() throws the MCP-facing rate limit error with Retry-After", () => {
  const limiter = new TokenBucketLimiter({ now: () => 0 });
  limiter.enforce("alice", 1);
  assert.throws(
    () => limiter.enforce("alice", 1),
    (error: unknown) =>
      error instanceof GatewayError &&
      error.code === ErrorCode.RateLimited &&
      error.httpStatus === 429 &&
      error.headers["Retry-After"] !== undefined &&
      error.toJsonRpc(7).error.data?.limit_rpm === 1,
  );
});

void test("idle full buckets are swept so the map does not grow without bound", () => {
  let now = 0;
  const limiter = new TokenBucketLimiter({ now: () => now });
  for (let i = 0; i < 50; i += 1) limiter.take(`caller-${i}`, 10);
  assert.equal(limiter.size(), 50);
  now += 5 * 60_000;
  limiter.take("fresh", 10);
  assert.equal(limiter.size(), 1);
});
