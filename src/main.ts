import { ConfigError, loadConfigFile } from "./config.js";
import { createGateway } from "./edge/server.js";
import { Logger } from "./log.js";
import type { LogLevel } from "./log.js";

const LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

async function main(): Promise<void> {
  const requested = process.env.GATEWAY_LOG_LEVEL;
  const level: LogLevel = requested && LEVELS.has(requested) ? (requested as LogLevel) : "info";
  const logger = new Logger({ level });
  const path = process.env.GATEWAY_CONFIG ?? "./gateway.yaml";
  const config = loadConfigFile(path);
  const gateway = createGateway(config, { logger });
  await gateway.start();

  const shutdown = (signal: string): void => {
    logger.info("shutting down", { signal });
    gateway.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`fatal: ${error.message}\n`);
  } else {
    process.stderr.write(`fatal: ${(error as Error).stack ?? String(error)}\n`);
  }
  process.exit(1);
});
