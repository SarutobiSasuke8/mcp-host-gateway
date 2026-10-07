import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, parseConfig, parseConfigYaml } from "../src/config.js";

const valid = {
  version: 1,
  listen: { port: 8080 },
  auth: { mode: "jwt", issuer: "https://accounts.example.com", audience: "mcp-host-gateway" },
  upstreams: { jobscout: { url: "https://jobscout.internal/mcp", tools_allow: ["search_jobs", "get_listing"] } },
  entitlements: {
    free: { upstreams: ["jobscout"], rpm: 30 },
    paid: { upstreams: ["jobscout"], rpm: 300 },
  },
};

void test("parses the documented config shape and applies defaults", () => {
  const config = parseConfig(valid);
  assert.equal(config.listen.host, "127.0.0.1");
  assert.equal(config.rate.scope, "identity");
  assert.equal(config.auth.mode, "jwt");
  if (config.auth.mode === "jwt") assert.equal(config.auth.plan_claim, "plan");
  assert.equal(config.upstreams.jobscout?.timeout_ms, 30_000);
});

void test("YAML without auth.mode defaults to jwt and still requires an issuer", () => {
  const yaml = `
version: 1
auth: { issuer: https://accounts.example.com, audience: mcp-host-gateway }
upstreams:
  jobscout: { url: https://jobscout.internal/mcp, tools_allow: [search_jobs, get_listing] }
entitlements:
  free: { upstreams: [jobscout], rpm: 30 }
`;
  const config = parseConfigYaml(yaml);
  assert.equal(config.auth.mode, "jwt");

  assert.throws(
    () => parseConfigYaml(yaml.replace("issuer: https://accounts.example.com, ", "")),
    (error: unknown) => error instanceof ConfigError && /auth\.issuer/.test(error.message),
  );
});

void test("fails closed when auth is missing entirely", () => {
  const { auth: _auth, ...withoutAuth } = valid;
  void _auth;
  assert.throws(() => parseConfig(withoutAuth), (error: unknown) => error instanceof ConfigError && /auth/.test(error.message));
});

void test("fails closed when no upstream is configured", () => {
  assert.throws(
    () => parseConfig({ ...valid, upstreams: {} }),
    (error: unknown) => error instanceof ConfigError && /at least one upstream/.test(error.message),
  );
});

void test("fails closed when a plan references an unknown upstream or tool", () => {
  assert.throws(
    () => parseConfig({ ...valid, entitlements: { free: { upstreams: ["source_pack"], rpm: 30 } } }),
    (error: unknown) => error instanceof ConfigError && /unknown upstream "source_pack"/.test(error.message),
  );
  assert.throws(
    () => parseConfig({ ...valid, entitlements: { free: { upstreams: ["jobscout"], rpm: 30, tools: { jobscout: ["admin_purge"] } } } }),
    (error: unknown) => error instanceof ConfigError && /not in upstreams\.jobscout\.tools_allow/.test(error.message),
  );
});

void test("rejects an upstream with an empty allow list", () => {
  assert.throws(
    () => parseConfig({ ...valid, upstreams: { jobscout: { url: "https://x.example/mcp", tools_allow: [] } } }),
    (error: unknown) => error instanceof ConfigError,
  );
});
