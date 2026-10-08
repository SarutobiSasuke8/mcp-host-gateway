import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseConfigYaml } from "../src/config.js";

/**
 * Static checks on the shipped deploy artefacts. These do not replace `scripts/docker-smoke.sh`
 * (which needs a Docker daemon); they stop the recipe drifting from the code between runs.
 */
const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

void test("deploy/gateway.yaml is a valid production-shaped config", () => {
  const config = parseConfigYaml(read("deploy/gateway.yaml"));
  assert.equal(config.auth.mode, "jwt");
  assert.equal(config.listen.host, "0.0.0.0");
  assert.equal(config.rate.store, "sqlite");
  assert.match(config.rate.sqlite_path, /^\/app\/data\//);
  assert.equal(config.audit.sink, "file");
  assert.match(config.audit.path, /^\/app\/data\//);
  assert.equal(config.upstreams.jobscout?.url, "http://jobscout:8080/mcp");
});

void test("Dockerfile is multi-stage, runs as non-root and health-checks /health", () => {
  const dockerfile = read("Dockerfile");
  assert.ok((dockerfile.match(/^FROM /gm) ?? []).length >= 2, "multi-stage");
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK .*\n?.*\/health/m);
  assert.doesNotMatch(dockerfile, /^COPY .*gateway\.yaml/m, "config is mounted, never baked in");
  const ignore = read(".dockerignore");
  for (const entry of [".env", "node_modules", "data", "gateway.yaml"]) assert.match(ignore, new RegExp(`^${entry.replace(".", "\\.")}$`, "m"));
});

void test("compose recipe publishes only the proxy and carries placeholders, not secrets", () => {
  const compose = read("deploy/compose.yaml");
  const published = compose.match(/^\s+- "\d+:\d+(\/udp)?"$/gm) ?? [];
  assert.deepEqual(published.map((p) => p.trim()), ['- "80:80"', '- "443:443"', '- "443:443/udp"']);
  assert.match(compose, /internal: true/);
  assert.match(compose, /jobscout-mcp\.git#621ddcf23ddeedb3dcd347f597500e893896b6a1/);
  const caddy = read("deploy/Caddyfile");
  assert.match(caddy, /reverse_proxy gateway:8080/);
  assert.match(caddy, /flush_interval -1/);
  for (const text of [compose, caddy, read("deploy/gateway.yaml"), read("deploy/.env.example")]) {
    assert.doesNotMatch(text, /eyJ[a-zA-Z0-9_-]{10,}\./, "no JWTs");
    assert.doesNotMatch(text, /Bearer [a-zA-Z0-9]{20,}/, "no bearer tokens");
  }
});
