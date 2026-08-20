import { loadAuthRegistry, TokenAuthRegistry } from "./auth-registry.js";
import { loadConfig } from "./config.js";
import { JsonlAuditSink } from "./governance/audit-sink.js";
import { createGatewayHttpServer, listen } from "./http-server.js";
import { logger } from "./logger.js";
import { Mem0Client } from "./mem0-client.js";
import { scopeFingerprint, scopeToMem0UserId } from "./scope.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const authRegistry = new TokenAuthRegistry(loadAuthRegistry(config));
  const mem0 = new Mem0Client(config.mem0);
  const auditSink = new JsonlAuditSink(config.governance.auditPath);
  // Project-Aware Scope (Phase 2): no shared MemoryService/ScopeResolver is
  // built here anymore. http-server.ts constructs one per HTTP request from
  // that request's resolved auth-registry entry, so mem0/auditSink — not a
  // pre-scoped service — are what the Gateway needs at startup.
  const server = createGatewayHttpServer(mem0, auditSink, config, logger, authRegistry, () => mem0.ready());

  await listen(server, config);
  logger.info("gateway_started", {
    host: config.server.host,
    port: config.server.port,
    scopeFingerprint: scopeFingerprint(scopeToMem0UserId(config.scope)),
  });

  const shutdown = (signal: string): void => {
    logger.info("gateway_stopping", { signal });
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  logger.error("gateway_start_failed", { errorType: error instanceof Error ? error.name : "unknown" });
  process.exitCode = 1;
});
