import { GatewayError } from "./errors.js";
import type { AddMemoryRequest, Mem0Client, SearchMemoryRequest, UpdateMemoryRequest } from "./mem0-client.js";
import { scopeToMem0UserId, type ScopeResolver } from "./scope.js";

const RESERVED_METADATA_KEYS = new Set(["user_id", "agent_id", "run_id"]);

export class MemoryService {
  constructor(
    private readonly client: Mem0Client,
    private readonly scopeResolver: ScopeResolver,
  ) {}

  async add(input: Omit<AddMemoryRequest, "user_id">): Promise<unknown> {
    const userId = await this.currentUserId();
    validateMetadata(input.metadata);
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
