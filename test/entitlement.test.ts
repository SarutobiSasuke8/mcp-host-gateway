import assert from "node:assert/strict";
import test from "node:test";

import type { Identity } from "../src/auth/index.js";
import { ErrorCode, GatewayError } from "../src/edge/errors.js";
import { EntitlementMap } from "../src/entitlement/index.js";
import { staticConfig } from "./support.js";

const map = new EntitlementMap(staticConfig("http://127.0.0.1:1/mcp"));
const free: Identity = { subject: "user-free", plan: "free", mode: "static" };
const paid: Identity = { subject: "user-paid", plan: "paid", mode: "static" };

const forbiddenMatching = (pattern: RegExp) => (error: unknown): boolean =>
  error instanceof GatewayError && error.code === ErrorCode.Forbidden && error.httpStatus === 403 && pattern.test(error.message);

void test("grants an upstream on the caller's plan, narrowed by the plan's tool list", () => {
  const grant = map.grant(free, "jobscout");
  assert.equal(grant.plan, "free");
  assert.equal(grant.rpm, 3);
  assert.deepEqual([...grant.tools], ["search_jobs"]);

  const paidGrant = map.grant(paid, "jobscout");
  assert.deepEqual([...paidGrant.tools].sort(), ["get_listing", "search_jobs"]);
});

void test("denies an upstream that is not on the caller's plan", () => {
  assert.throws(() => map.grant(free, "source_pack"), forbiddenMatching(/plan "free" does not include upstream "source_pack"/));
  assert.doesNotThrow(() => map.grant(paid, "source_pack"));
});

void test("denies a tool outside the grant, including tools the upstream has but never allows", () => {
  const grant = map.grant(free, "jobscout");
  assert.throws(() => map.assertTool(grant, "get_listing"), forbiddenMatching(/tool "get_listing" is not available on plan "free"/));
  assert.throws(() => map.assertTool(grant, "admin_purge"), forbiddenMatching(/admin_purge/));
  assert.doesNotThrow(() => map.assertTool(grant, "search_jobs"));

  const paidGrant = map.grant(paid, "jobscout");
  assert.throws(() => map.assertTool(paidGrant, "admin_purge"), forbiddenMatching(/admin_purge/));
});

void test("denies identities with no plan or an unknown plan", () => {
  assert.throws(() => map.grant({ subject: "x", plan: undefined, mode: "jwt" }, "jobscout"), forbiddenMatching(/no plan/));
  assert.throws(() => map.grant({ subject: "x", plan: "enterprise", mode: "jwt" }, "jobscout"), forbiddenMatching(/plan "enterprise" is not recognised/));
  assert.throws(() => map.grant(paid, "nope"), forbiddenMatching(/upstream "nope" is not configured/));
});
