import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { JsonlAuditSink } from "../../src/governance/audit-sink.js";
import { Mem0Client } from "../../src/mem0-client.js";
import { MemoryService } from "../../src/memory-service.js";
import { StaticScopeResolver, scopeToMem0UserId } from "../../src/scope.js";

const apiKey = process.env.MEM0_API_KEY ?? "";
const enabled = process.env.RUN_MEM0_INTEGRATION === "1" && apiKey.length > 0;
const integration = enabled ? describe : describe.skip;

integration("running self-hosted Mem0", () => {
  const suffix = randomUUID();
  const scope = { tenant: "integration-test", project: `run-${suffix}`, subject: "gateway" };
  const expectedUserId = scopeToMem0UserId(scope);
  const client = new Mem0Client({
    baseUrl: new URL(process.env.MEM0_BASE_URL ?? "http://127.0.0.1:8888"),
    apiKey,
    timeoutMs: 60_000,
  });
  const auditDir = mkdtempSync(join(tmpdir(), "luvira-integration-audit-"));
  const auditSink = new JsonlAuditSink(join(auditDir, "audit.jsonl"));
  const service = new MemoryService(client, new StaticScopeResolver(scope), auditSink);
  const createdIds = new Set<string>();
  const marker = `luvira-integration-${suffix}`;

  afterAll(async () => {
    for (const id of createdIds) {
      try {
        await service.delete(id);
      } catch {
        // The main test may already have deleted it. Never delete anything not created in this run.
      }
    }
    await rm(auditDir, { recursive: true, force: true });
  });

  it("performs add, search, owned get, update, and delete in an isolated scope", async () => {
    const added = await service.add({
      messages: [{ role: "user", content: marker }],
      metadata: { source_type: "integration_test", authority: "supplemental", test_run: suffix },
      infer: false,
    });
    const id = findCreatedId(added);
    expect(id).toBeTruthy();
    createdIds.add(id);

    const found = await service.search({ query: marker, top_k: 10, explain: true, show_expired: false });
    expect(JSON.stringify(found)).toContain(id);

    const fetched = await service.get(id);
    expect(fetched).toMatchObject({ id, user_id: expectedUserId });

    const updatedText = `${marker}-updated`;
    await service.update(id, { text: updatedText });
    expect(await service.get(id)).toMatchObject({ id, user_id: expectedUserId, memory: updatedText });

    await service.delete(id);
    createdIds.delete(id);
  });
});

function findCreatedId(payload: unknown): string {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Mem0 create response was not an object");
  }
  const results = (payload as Record<string, unknown>).results;
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error("Mem0 create response contained no results");
  }
  const first = results[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) {
    throw new Error("Mem0 create result was not an object");
  }
  const id = (first as Record<string, unknown>).id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Mem0 create result contained no id");
  }
  return id;
}
