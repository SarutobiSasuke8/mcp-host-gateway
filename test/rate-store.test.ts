import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseConfig } from "../src/config.js";
import { createRateStore } from "../src/edge/server.js";
import { TokenBucketLimiter } from "../src/rate/index.js";
import type { RateStore } from "../src/rate/index.js";
import { SqliteRateStore } from "../src/rate/sqlite.js";
import { FREE_TOKEN, PAID_TOKEN, STATIC_TOKENS_ENV, bearer, rpc, startStubUpstream } from "./support.js";

const MAIN = fileURLToPath(new URL("../src/main.js", import.meta.url));

function tempDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "mcp-gw-rate-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

/** The same burst-and-refill script must hold for every store. */
async function exerciseBucket(make: (now: () => number) => RateStore): Promise<void> {
  let now = 1_000_000;
  const store = make(() => now);
  try {
    for (let i = 0; i < 5; i += 1) {
      const decision = await store.take("alice", 5);
      assert.equal(decision.allowed, true, `${store.kind}: request ${i + 1}`);
      assert.equal(decision.remaining, 4 - i);
    }
    const denied = await store.take("alice", 5);
    assert.equal(denied.allowed, false);
    assert.ok(denied.retryAfterSeconds >= 1);
    assert.equal((await store.take("bob", 5)).allowed, true, `${store.kind}: separate key`);
    now += 12_000;
    assert.equal((await store.take("alice", 5)).allowed, true, `${store.kind}: one token refilled`);
    assert.equal((await store.take("alice", 5)).allowed, false);
  } finally {
    await store.close?.();
  }
}

void test("memory and SQLite stores apply identical token bucket rules", async () => {
  const tmp = tempDir();
  try {
    await exerciseBucket((now) => new TokenBucketLimiter({ now }));
    await exerciseBucket((now) => new SqliteRateStore(join(tmp.dir, "rules.sqlite"), { now }));
  } finally {
    tmp.cleanup();
  }
});

void test("SQLite store runs in WAL mode and keeps limits across a restart", () => {
  const tmp = tempDir();
  try {
    const path = join(tmp.dir, "nested", "rate.sqlite");
    const first = new SqliteRateStore(path);
    assert.equal(first.journalMode(), "wal");
    for (let i = 0; i < 3; i += 1) assert.equal(first.take("user-free", 3).allowed, true);
    first.close();

    const second = new SqliteRateStore(path);
    try {
      const after = second.take("user-free", 3);
      assert.equal(after.allowed, false, "quota spent before the restart is still spent");
      assert.ok(after.retryAfterSeconds >= 1);
      assert.equal(second.take("someone-else", 3).allowed, true);
    } finally {
      second.close();
    }
  } finally {
    tmp.cleanup();
  }
});

void test("two store handles on one file share a single bucket", () => {
  const tmp = tempDir();
  try {
    const path = join(tmp.dir, "shared.sqlite");
    const a = new SqliteRateStore(path);
    const b = new SqliteRateStore(path);
    try {
      const results = [a, b, a, b, a, b].map((store) => store.take("k", 4).allowed);
      assert.deepEqual(results, [true, true, true, true, false, false]);
    } finally {
      a.close();
      b.close();
    }
  } finally {
    tmp.cleanup();
  }
});

void test("config selects the store", () => {
  const base = {
    version: 1,
    auth: { mode: "static" },
    upstreams: { jobscout: { url: "http://127.0.0.1:1/mcp", tools_allow: ["x"] } },
    entitlements: { free: { upstreams: ["jobscout"], rpm: 3 } },
  };
  const memory = createRateStore(parseConfig(base).rate);
  assert.equal(memory.kind, "memory");
  const tmp = tempDir();
  try {
    const sqlite = createRateStore(parseConfig({ ...base, rate: { store: "sqlite", sqlite_path: join(tmp.dir, "c.sqlite") } }).rate);
    assert.equal(sqlite.kind, "sqlite");
    void sqlite.close?.();
  } finally {
    tmp.cleanup();
  }
});

interface GatewayProcess {
  child: ChildProcess;
  base: string;
  stop(): Promise<void>;
}

/** Start `node dist/src/main.js` as a real separate process and wait for it to listen. */
async function startGatewayProcess(configPath: string): Promise<GatewayProcess> {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN], {
    env: { ...process.env, GATEWAY_CONFIG: configPath, GATEWAY_STATIC_TOKENS: STATIC_TOKENS_ENV, GATEWAY_LOG_LEVEL: "info" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`gateway process did not start: ${stderr}`)), 15_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (const line of buffer.split("\n")) {
        if (!line.includes('"gateway listening"')) continue;
        clearTimeout(timer);
        resolve((JSON.parse(line) as { port: number }).port);
        return;
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`gateway process exited with ${code}: ${stderr}`));
    });
  });
  return {
    child,
    base: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}

void test("two gateway processes sharing one SQLite store enforce one limit, and it survives a full restart", async () => {
  const tmp = tempDir();
  const upstream = await startStubUpstream();
  const processes: GatewayProcess[] = [];
  try {
    const configPath = join(tmp.dir, "gateway.yaml");
    const config = {
      version: 1,
      listen: { host: "127.0.0.1", port: 0 },
      auth: { mode: "static", tokens_env: "GATEWAY_STATIC_TOKENS" },
      upstreams: { jobscout: { url: upstream.url, tools_allow: ["search_jobs"] } },
      entitlements: { free: { upstreams: ["jobscout"], rpm: 5 }, paid: { upstreams: ["jobscout"], rpm: 10 } },
      rate: { store: "sqlite", sqlite_path: join(tmp.dir, "rate.sqlite") },
      audit: { sink: "file", path: join(tmp.dir, "audit.jsonl") },
    };
    writeFileSync(configPath, JSON.stringify(config));

    processes.push(await startGatewayProcess(configPath), await startGatewayProcess(configPath));
    const [a, b] = processes as [GatewayProcess, GatewayProcess];
    assert.notEqual(a.child.pid, b.child.pid);

    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const target = i % 2 === 0 ? a : b;
      const reply = await rpc(target.base, "jobscout", { jsonrpc: "2.0", id: i, method: "ping" }, bearer(FREE_TOKEN));
      statuses.push(reply.status);
    }
    // rpm 5 across both processes, not 5 each: alternating calls get 5 allowed in total.
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429, 429]);
    assert.equal(upstream.received.length, 5);

    // Concurrent burst from both processes at once: still exactly rpm allowed in total.
    const burst = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        rpc((i % 2 === 0 ? a : b).base, "jobscout", { jsonrpc: "2.0", id: 100 + i, method: "ping" }, bearer(PAID_TOKEN)),
      ),
    );
    assert.equal(burst.filter((r) => r.status === 200).length, 10);
    assert.equal(burst.filter((r) => r.status === 429).length, 20);
    assert.equal(upstream.received.length, 15);

    await Promise.all(processes.splice(0).map((p) => p.stop()));

    // Full restart: a fresh process on the same store still sees the spent quota.
    const c = await startGatewayProcess(configPath);
    processes.push(c);
    const afterRestart = await rpc(c.base, "jobscout", { jsonrpc: "2.0", id: 99, method: "ping" }, bearer(FREE_TOKEN));
    assert.equal(afterRestart.status, 429);
    assert.equal(upstream.received.length, 15);
  } finally {
    await Promise.all(processes.map((p) => p.stop()));
    await upstream.close();
    tmp.cleanup();
  }
});
