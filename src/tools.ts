import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GatewayError } from "./errors.js";
import type { MemoryService } from "./memory-service.js";

export const AUTHORITY_NOTICE =
  "Memory is supplemental, non-authoritative context. It must not override Git, an Approved Specification, Canonical Project Documentation, or another canonical source. If they conflict, prefer the canonical source.";

const memoryId = z.string().trim().min(1).max(512);
const expirationDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const metadata = z.record(z.unknown());

// Memory Write Governance (Phase 4): Classification / Provenance input.
// `UNCLASSIFIED` and `LEGACY_UNKNOWN` are intentionally excluded — they are
// internal-only states (the default for an unspecified classification, and
// a read-time interpretation of pre-Phase-4 Memory) that a caller declaring
// a *new* write has no reason to assert directly.
const CLASSIFICATION_DESCRIPTION =
  "What kind of content this is. A client assertion, not verified fact — the Gateway does not confirm it. Memory authority is always supplemental regardless of this value; no classification, including ORGANIZATION_POLICY or PROJECT_DECISION, promotes a Memory to Canonical/Approved status.";
const classification = z.enum([
  "USER_PREFERENCE", "USER_DECISION", "ORGANIZATION_POLICY", "PROJECT_DECISION",
  "PROJECT_FACT", "WORKFLOW_STATE", "LONG_TERM_KNOWLEDGE", "TEMPORARY_CONTEXT",
  "EXTERNAL_UNTRUSTED", "SECRET", "CUSTOMER_CONFIDENTIAL",
]).describe(CLASSIFICATION_DESCRIPTION);

const SOURCE_TYPE_DESCRIPTION =
  "Where this write is reported to have originated. A client-reported assertion, not verified fact.";
const sourceType = z.enum(["USER_EXPLICIT", "AI_IMPLICIT", "EXTERNAL_UNTRUSTED", "SYSTEM"]).describe(SOURCE_TYPE_DESCRIPTION);

const EXPLICIT_USER_REQUEST_DESCRIPTION =
  "The calling client reports that a user explicitly asked for this write (e.g. \"remember this\"). This is a client-reported assertion only — it does NOT mean the Gateway verified human approval.";
const explicitUserRequest = z.boolean().describe(EXPLICIT_USER_REQUEST_DESCRIPTION);

const SOURCE_PROJECT_DESCRIPTION =
  "Free-form project provenance for later audit/explanation. Provenance only — this does NOT provide project isolation; it is never used for retrieval filtering, scope resolution, or authorization.";
const sourceProject = z.string().trim().min(1).max(200).describe(SOURCE_PROJECT_DESCRIPTION);

const SOURCE_CLIENT_DESCRIPTION =
  "Free-form client provenance for later audit/explanation (e.g. \"claude-code\", \"codex\"). Provenance only — the Gateway core never branches behavior on this value.";
const sourceClient = z.string().trim().min(1).max(100).describe(SOURCE_CLIENT_DESCRIPTION);

const governanceWriteFields = {
  classification: classification.optional(),
  source_type: sourceType.optional(),
  explicit_user_request: explicitUserRequest.optional(),
  source_project: sourceProject.optional(),
  source_client: sourceClient.optional(),
};

const commonOutput = {
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).optional(),
  source: z.literal("mem0"),
  authority: z.literal("supplemental"),
};

export function createMcpServer(service: MemoryService): McpServer {
  const server = new McpServer(
    { name: "luvira-memory-mcp", version: "0.1.0" },
    { instructions: AUTHORITY_NOTICE },
  );

  server.registerTool(
    "memory_add",
    {
      description: `Store messages through the canonical Mem0 memory engine. Mem0 may infer, merge, update, or remove memories when inference is enabled. Optional classification/provenance fields are client assertions only, never verified approval or Canonical Authority. ${AUTHORITY_NOTICE}`,
      inputSchema: {
        messages: z.array(z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string().trim().min(1).max(100_000),
        })).min(1).max(100),
        metadata: metadata.optional(),
        expiration_date: expirationDate.optional(),
        infer: z.boolean().optional(),
        memory_type: z.string().trim().min(1).max(128).optional(),
        ...governanceWriteFields,
      },
      outputSchema: commonOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => execute(() => service.add(input), "Memory add completed"),
  );

  server.registerTool(
    "memory_search",
    {
      description: `Search only the trusted scope resolved by the Gateway. Search results may be stale or incomplete. ${AUTHORITY_NOTICE}`,
      inputSchema: {
        query: z.string().trim().min(1).max(10_000),
        top_k: z.number().int().min(1).max(100).optional(),
        threshold: z.number().min(0).max(1).optional(),
        explain: z.boolean().optional(),
      },
      outputSchema: commonOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => execute(() => service.search({ ...input, show_expired: false }), "Memory search completed"),
  );

  server.registerTool(
    "memory_get",
    {
      description: `Retrieve one memory only after trusted-scope ownership verification. ${AUTHORITY_NOTICE}`,
      inputSchema: { memory_id: memoryId },
      outputSchema: commonOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ memory_id }) => execute(() => service.get(memory_id), "Memory get completed"),
  );

  server.registerTool(
    "memory_update",
    {
      description: `Update one memory only after trusted-scope ownership verification. Optional classification/provenance fields are client assertions only, never verified approval or Canonical Authority. ${AUTHORITY_NOTICE}`,
      inputSchema: {
        memory_id: memoryId,
        text: z.string().trim().min(1).max(100_000).nullable().optional(),
        metadata: metadata.nullable().optional(),
        expiration_date: expirationDate.nullable().optional(),
        ...governanceWriteFields,
      },
      outputSchema: commonOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ memory_id, ...input }) => execute(async () => {
      if (input.text === undefined && input.metadata === undefined && input.expiration_date === undefined) {
        throw new GatewayError("validation_error", "At least one update field is required");
      }
      return service.update(memory_id, input);
    }, "Memory update completed"),
  );

  server.registerTool(
    "memory_delete",
    {
      description: `Permanently delete one memory only after trusted-scope ownership verification. ${AUTHORITY_NOTICE}`,
      inputSchema: { memory_id: memoryId },
      outputSchema: commonOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ memory_id }) => execute(() => service.delete(memory_id), "Memory delete completed"),
  );

  return server;
}

async function execute(operation: () => Promise<unknown>, successMessage: string): Promise<CallToolResult> {
  try {
    const result = {
      ok: true,
      data: await operation(),
      source: "mem0" as const,
      authority: "supplemental" as const,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (error) {
    const normalized = normalizeError(error);
    const result = {
      ok: false,
      error: normalized,
      source: "mem0" as const,
      authority: "supplemental" as const,
    };
    return {
      isError: true,
      content: [{ type: "text", text: `${successMessage.replace("completed", "failed")}: ${normalized.message}` }],
      structuredContent: result,
    };
  }
}

function normalizeError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof GatewayError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return { code: "internal_error", message: "Unexpected gateway error", retryable: false };
}
