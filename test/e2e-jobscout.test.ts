import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { AuditLog } from "../src/audit.js";
import { parseConfig } from "../src/config.js";
import { createGateway } from "../src/edge/server.js";
import type { Gateway } from "../src/edge/server.js";
import { silentLogger } from "../src/log.js";
import { TokenBucketLimiter } from "../src/rate/index.js";

/**
 * End to end against the real JobScout MCP server (jobscout-mcp, pinned by git SHA in
 * devDependencies), driven through the gateway by the official MCP TypeScript client.
 *
 * Offline: every JobScout provider is disabled by default and JobSpy is forced off in hosted
 * mode, and the provider endpoints are pointed at a closed local port as a second guard, so
 * nothing leaves the machine. JobScout's own `setup_required` answer proves no provider ran.
 */
const JOBSCOUT_HTTP = fileURLToPath(new URL("../../node_modules/@sarutobi-sasuke/jobscout-mcp/dist/src/http-server.js", import.meta.url));
const FREE = "e2e-free-token-0123456789";
const PAID = "e2e-paid-token-0123456789";
const ALL_TOOLS = [
  "jobscout_list_sources",
  "jobscout_search_jobs",
  "jobscout_classify_jobs",
  "jobscout_deduplicate",
  "jobscout_source_yield",
  "jobscout_briefing",
];

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function startJobScout(): Promise<{ child: ChildProcess; url: string; stop(): Promise<void> }> {
  const port = await freePort();
  const dead = "http://127.0.0.1:9/";
  const child = spawn(process.execPath, [JOBSCOUT_HTTP], {
    env: {
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      PORT: String(port),
      HOST: "127.0.0.1",
      JOBSCOUT_ENABLE_JOBSPY: "false",
      HIMALAYAS_MCP_URL: dead,
      WWR_RSS_URL: dead,
      REMOTEOK_API_URL: dead,
      LENNYSJOBS_ENDPOINT: dead,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`jobscout-mcp-http exited: ${stderr}`);
    try {
      const health = await fetch(`${base}/health`);
      if (health.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`jobscout-mcp-http did not start: ${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    child,
    url: `${base}/mcp`,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}

function clientFor(base: string, token: string): { client: Client; transport: StreamableHTTPClientTransport } {
  const client = new Client({ name: "gateway-e2e", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp/jobscout`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  return { client, transport };
}

const textOf = (result: unknown): string =>
  ((result as { content: Array<{ type: string; text: string }> }).content.find((c) => c.type === "text")?.text ?? "");

void test("e2e: official MCP client through the gateway to the real JobScout HTTP server, offline", async () => {
  const jobscout = await startJobScout();
  const audit: string[] = [];
  let gateway: Gateway | undefined;
  try {
    const config = parseConfig({
      version: 1,
      listen: { host: "127.0.0.1", port: 0 },
      auth: { mode: "static", tokens_env: "GATEWAY_STATIC_TOKENS" },
      upstreams: {
        jobscout: { url: jobscout.url, tools_allow: ALL_TOOLS, prompts_allow: ["jobscout_setup", "jobscout_find_jobs"], timeout_ms: 20_000 },
      },
      entitlements: {
        free: { upstreams: ["jobscout"], rpm: 8, tools: { jobscout: ["jobscout_list_sources", "jobscout_search_jobs"] }, prompts: { jobscout: [] } },
        paid: { upstreams: ["jobscout"], rpm: 300 },
      },
    });
    gateway = createGateway(config, {
      logger: silentLogger,
      env: { GATEWAY_STATIC_TOKENS: `${FREE}:e2e-free:free,${PAID}:e2e-paid:paid` },
      limiter: new TokenBucketLimiter(),
      audit: new AuditLog({ write: (line) => audit.push(line) }),
    });
    const base = `http://127.0.0.1:${await gateway.start()}`;

    // Free plan: initialise, filtered tools, honest capabilities, allowed call, denied call, rate limit.
    const free = clientFor(base, FREE);
    await free.client.connect(free.transport);
    assert.equal(free.client.getServerVersion()?.name, "jobscout-mcp");
    const freeCaps = free.client.getServerCapabilities() ?? {};
    assert.ok(freeCaps.tools, "tools capability advertised");
    assert.equal(freeCaps.prompts, undefined, "free plan has no prompts, so prompts is not advertised");

    const tools = (await free.client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["jobscout_list_sources", "jobscout_search_jobs"]);

    const sources = await free.client.callTool({ name: "jobscout_list_sources", arguments: {} });
    const listed = JSON.parse(textOf(sources)) as { sources: Array<{ id: string; enabled: boolean }> };
    assert.ok(listed.sources.length >= 5);
    assert.ok(listed.sources.every((s) => s.enabled === false), "every provider is off: the run is offline");

    const search = await free.client.callTool({ name: "jobscout_search_jobs", arguments: { query: "engineer" } });
    assert.match(textOf(search), /"setup_required": true/, "JobScout reports that nothing was searched");

    await assert.rejects(
      free.client.callTool({ name: "jobscout_deduplicate", arguments: { jobs: [] } }),
      (error: Error) => /-32003/.test(error.message) && /jobscout_deduplicate/.test(error.message) && /plan \\"free\\"|plan "free"/.test(error.message),
    );

    // rpm 8: initialize, notifications/initialized, tools/list, two calls and the denied call
    // have spent 6. Two more pass, then the gateway refuses.
    await free.client.ping();
    await free.client.ping();
    await assert.rejects(free.client.ping(), (error: Error) => /-32029/.test(error.message) && /Rate limit exceeded/.test(error.message));
    await free.client.close();

    // Paid plan: every tool and both onboarding prompts, end to end.
    const paid = clientFor(base, PAID);
    await paid.client.connect(paid.transport);
    assert.ok(paid.client.getServerCapabilities()?.prompts, "paid plan sees the prompts capability");
    assert.deepEqual((await paid.client.listTools()).tools.map((t) => t.name).sort(), [...ALL_TOOLS].sort());
    assert.deepEqual((await paid.client.listPrompts()).prompts.map((p) => p.name).sort(), ["jobscout_find_jobs", "jobscout_setup"]);
    const prompt = await paid.client.getPrompt({ name: "jobscout_setup" });
    assert.match(JSON.stringify(prompt.messages), /jobscout_list_sources/);
    await paid.client.close();

    // The audit trail saw every one of those calls and never a token.
    const joined = audit.join("\n");
    assert.ok(audit.length >= 14);
    assert.ok(!joined.includes(FREE) && !joined.includes(PAID));
    const decisions = audit.map((line) => (JSON.parse(line) as { decision: string }).decision);
    assert.ok(decisions.includes("allow") && decisions.includes("deny") && decisions.includes("rate_limited"));
  } finally {
    await gateway?.stop();
    await jobscout.stop();
  }
});
