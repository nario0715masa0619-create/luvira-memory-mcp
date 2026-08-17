import { GatewayError } from "./errors.js";
import { detectHighConfidenceSecret, type SecretDetectionInput } from "./governance/secret-detection.js";
import type { AddMemoryRequest, Mem0Client, SearchMemoryRequest, UpdateMemoryRequest } from "./mem0-client.js";
import { scopeToMem0UserId, type ScopeResolver } from "./scope.js";

const RESERVED_METADATA_KEYS = new Set(["user_id", "agent_id", "run_id"]);
const SECRET_BLOCKED_MESSAGE = "Memory write blocked by governance policy.";

export class MemoryService {
  constructor(
    private readonly client: Mem0Client,
    private readonly scopeResolver: ScopeResolver,
  ) {}

  async add(input: Omit<AddMemoryRequest, "user_id">): Promise<unknown> {
    const userId = await this.currentUserId();
    validateMetadata(input.metadata);
    assertNoHighConfidenceSecret({ texts: input.messages.map((message) => message.content), metadata: input.metadata });
    return this.client.add({ ...input, user_id: userId });
  }

  async search(input: Omit<SearchMemoryRequest, "filters">): Promise<unknown> {
    const userId = await this.currentUserId();
    return this.client.search({ ...input, filters: { user_id: userId } });
  }

  async get(memoryId: string): Promise<unknown> {
    const userId = await this.currentUserId();
    return this.getOwned(memoryId, userId);
  }

  async update(memoryId: string, input: UpdateMemoryRequest): Promise<unknown> {
    const userId = await this.currentUserId();
    validateMetadata(input.metadata);
    // Secret check runs before the ownership preflight (getOwned), which is
    // itself a Mem0 call: a payload that will be blocked regardless should
    // not spend an extra upstream round trip first. This ordering does not
    // create a new ownership side channel — the block decision depends only
    // on the submitted payload, never on whether memoryId exists or is
    // owned by the caller, so the response is identical either way.
    assertNoHighConfidenceSecret({ texts: [input.text], metadata: input.metadata });
    await this.getOwned(memoryId, userId);
    return this.client.update(memoryId, input);
  }

  async delete(memoryId: string): Promise<unknown> {
    const userId = await this.currentUserId();
    await this.getOwned(memoryId, userId);
    return this.client.delete(memoryId);
  }

  private async currentUserId(): Promise<string> {
    return scopeToMem0UserId(await this.scopeResolver.resolve());
  }

  private async getOwned(memoryId: string, expectedUserId: string): Promise<unknown> {
    const memory = await this.client.get(memoryId);
    const actualUserId = extractUserId(memory);
    if (actualUserId === undefined) {
      throw new GatewayError("upstream_contract_error", "Mem0 memory response lacks user_id");
    }
    if (actualUserId !== expectedUserId) {
      throw new GatewayError("not_found", "Memory not found");
    }
    return memory;
  }
}

function extractUserId(memory: unknown): string | undefined {
  if (memory === null || typeof memory !== "object" || Array.isArray(memory)) return undefined;
  const userId = (memory as Record<string, unknown>).user_id;
  return typeof userId === "string" ? userId : undefined;
}

function validateMetadata(metadata: Record<string, unknown> | null | undefined): void {
  if (metadata === null || metadata === undefined) return;
  for (const key of Object.keys(metadata)) {
    if (RESERVED_METADATA_KEYS.has(key)) {
      throw new GatewayError("validation_error", `Metadata key '${key}' is reserved`);
    }
  }
}

/**
 * Memory Write Governance (Phase 3, AR-4): blocks ADD/UPDATE payloads that
 * match a high-confidence secret pattern before any Mem0 call is made. The
 * thrown error never includes the matched value or which pattern matched.
 */
function assertNoHighConfidenceSecret(input: SecretDetectionInput): void {
  const result = detectHighConfidenceSecret(input);
  if (result.riskTier === "HIGH_CONFIDENCE") {
    throw new GatewayError("secret_detected_high_confidence", SECRET_BLOCKED_MESSAGE, false);
  }
}
