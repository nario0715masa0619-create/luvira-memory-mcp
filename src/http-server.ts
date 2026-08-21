import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { toRequestContext, type TokenAuthRegistry } from "./auth-registry.js";
import type { AppConfig } from "./config.js";
import type { AuditSink } from "./governance/audit-sink.js";
import type { Logger } from "./logger.js";
import type { Mem0Client } from "./mem0-client.js";
import { MemoryService } from "./memory-service.js";
import { StaticScopeResolver } from "./scope.js";
import { createMcpServer } from "./tools.js";

const MAX_REQUEST_BYTES = 1024 * 1024;

export type ReadinessCheck = () => Promise<void>;

export function createGatewayHttpServer(
  mem0: Mem0Client,
  auditSink: AuditSink,
  config: AppConfig,
  logger: Logger,
  authRegistry: TokenAuthRegistry,
  readinessCheck: ReadinessCheck = async () => {},
): Server {
  return createServer(async (request, response) => {
    const startedAt = performance.now();
    const requestId = crypto.randomUUID();
    try {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/health/live") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (path === "/health/ready") {
        try {
          await readinessCheck();
          sendJson(response, 200, { status: "ready" });
        } catch {
          sendJson(response, 503, { status: "not_ready" });
        }
        return;
      }
      if (path !== "/mcp") {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      if (!isAllowedOrigin(request, config.server.allowedOrigins)) {
        sendJson(response, 403, { error: "forbidden" });
        return;
      }
      const authEntry = resolveAuthEntry(request, authRegistry);
      if (authEntry === undefined) {
        response.setHeader("WWW-Authenticate", "Bearer");
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      // Project-Aware Scope (Phase 2/3): the resolved entry's scope, role,
      // and credential fingerprint become this request's — and only this
      // request's — values. `token` never leaves resolveAuthEntry/authEntry;
      // toRequestContext strips it before anything else touches the result.
      const requestContext = toRequestContext(authEntry);
      if (!new Set(["GET", "POST", "DELETE"]).has(request.method ?? "")) {
        response.setHeader("Allow", "GET, POST, DELETE");
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }

      const parsedBody = request.method === "POST" ? await readJsonBody(request) : undefined;
      // A fresh StaticScopeResolver + MemoryService per request — not a
      // process-global resolver reused across requests — is what makes two
      // concurrent requests presenting different tokens resolve to
      // different Mem0 user_ids and different write roles. No mutable
      // shared state is written here.
      const requestScopeResolver = new StaticScopeResolver(requestContext.scope);
      const requestService = new MemoryService(
        mem0,
        requestScopeResolver,
        auditSink,
        requestContext.role,
        requestContext.credentialFingerprint,
      );
      const mcpServer = createMcpServer(requestService);
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      transport.onerror = () => logger.error("mcp_transport_error", { requestId });
      // SDK 1.29's concrete transport uses explicit `| undefined` callbacks while
      // its Transport interface uses optional callbacks. Runtime shapes are compatible.
      await mcpServer.connect(transport as Transport);
      response.once("close", () => {
        void transport.close();
        void mcpServer.close();
      });
      await transport.handleRequest(request, response, parsedBody);
    } catch (error) {
      logger.error("http_request_error", {
        requestId,
        errorType: error instanceof Error ? error.name : "unknown",
      });
      if (!response.headersSent) sendJson(response, 400, { error: "invalid_request" });
      else response.end();
    } finally {
      logger.info("http_request_complete", {
        requestId,
        method: request.method,
        status: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
  });
}

export async function listen(server: Server, config: AppConfig): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.server.port, config.server.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function isAllowedOrigin(request: IncomingMessage, allowed: ReadonlySet<string>): boolean {
  const origin = request.headers.origin;
  return origin === undefined || allowed.has(origin);
}

function resolveAuthEntry(request: IncomingMessage, authRegistry: TokenAuthRegistry) {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) return undefined;
  return authRegistry.resolve(header.slice("Bearer ".length));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("Request too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}
