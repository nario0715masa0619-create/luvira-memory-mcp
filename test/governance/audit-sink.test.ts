import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlAuditSink } from "../../src/governance/audit-sink.js";
import type { GovernanceAuditEvent } from "../../src/governance/types.js";

const tempDirectories: string[] = [];

async function temporaryPath(...parts: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "luvira-audit-"));
  tempDirectories.push(directory);
  return join(directory, ...parts);
}

function event(overrides: Partial<GovernanceAuditEvent> = {}): GovernanceAuditEvent {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    operation: "ADD",
    classification: "UNCLASSIFIED",
    decision: "ALLOW",
    reasonCodes: [],
    scopeFingerprint: "scope-fingerprint",
    role: "read_write",
    credentialFingerprint: "credential-fingerprint",
    ...overrides,
  };
}

async function lines(filePath: string): Promise<string[]> {
  return (await readFile(filePath, "utf8")).split("\n");
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JsonlAuditSink", () => {
  it("appends a single event as one valid JSON line", async () => {
    const filePath = await temporaryPath("audit.jsonl");
    const auditEvent = event();

    await new JsonlAuditSink(filePath).record(auditEvent);

    const persisted = await lines(filePath);
    expect(persisted).toHaveLength(1);
    expect(JSON.parse(persisted[0]!)).toEqual(auditEvent);
  });

  it("preserves previous records when appending multiple events", async () => {
    const filePath = await temporaryPath("audit.jsonl");
    const sink = new JsonlAuditSink(filePath);

    await sink.record(event({ requestId: "first" }));
    await sink.record(event({ requestId: "second", operation: "UPDATE" }));

    expect((await lines(filePath)).map((line) => JSON.parse(line).requestId)).toEqual(["first", "second"]);
  });

  it("creates missing parent directories recursively", async () => {
    const filePath = await temporaryPath("nested", "audit", "events.jsonl");

    await new JsonlAuditSink(filePath).record(event());

    expect(await readFile(filePath, "utf8")).toBe(JSON.stringify(event()));
  });

  it("omits undefined optional fields", async () => {
    const filePath = await temporaryPath("audit.jsonl");

    await new JsonlAuditSink(filePath).record(event());

    expect(JSON.parse(await readFile(filePath, "utf8"))).not.toHaveProperty("requestId");
  });

  it("records every parallel call without loss", async () => {
    const filePath = await temporaryPath("audit.jsonl");
    const sink = new JsonlAuditSink(filePath);
    const expectedIds = Array.from({ length: 40 }, (_, index) => `request-${index}`);

    await Promise.all(expectedIds.map((requestId) => sink.record(event({ requestId }))));

    const actualIds = (await lines(filePath)).map((line) => JSON.parse(line).requestId);
    expect(actualIds).toHaveLength(expectedIds.length);
    expect(new Set(actualIds)).toEqual(new Set(expectedIds));
  });

  it("rejects an I/O failure and remains usable for a later call", async () => {
    const parentFile = await temporaryPath("not-a-directory");
    await writeFile(parentFile, "existing", "utf8");
    const sink = new JsonlAuditSink(join(parentFile, "audit.jsonl"));

    await expect(sink.record(event({ requestId: "first" }))).rejects.toThrow();
    await expect(sink.record(event({ requestId: "second" }))).rejects.toThrow();
  });

  it("serializes Unicode and embedded newlines without creating extra lines", async () => {
    const filePath = await temporaryPath("audit.jsonl");
    const auditEvent = event({ requestId: "日本語\nsecond-line" });

    await new JsonlAuditSink(filePath).record(auditEvent);

    const persisted = await lines(filePath);
    expect(persisted).toHaveLength(1);
    expect(JSON.parse(persisted[0]!)).toEqual(auditEvent);
  });

  it("preserves an existing file that has no trailing newline", async () => {
    const filePath = await temporaryPath("audit.jsonl");
    const existing = event({ requestId: "existing" });
    await writeFile(filePath, JSON.stringify(existing), "utf8");

    await new JsonlAuditSink(filePath).record(event({ requestId: "new" }));

    expect((await lines(filePath)).map((line) => JSON.parse(line).requestId)).toEqual(["existing", "new"]);
  });

  it("does not introduce a blank line when an existing file has a trailing newline", async () => {
    const filePath = await temporaryPath("audit.jsonl");
    const existing = event({ requestId: "existing" });
    await writeFile(filePath, `${JSON.stringify(existing)}\n`, "utf8");

    await new JsonlAuditSink(filePath).record(event({ requestId: "new" }));

    expect((await lines(filePath)).map((line) => JSON.parse(line).requestId)).toEqual(["existing", "new"]);
  });

  it("accepts only GovernanceAuditEvent and persists no fields beyond the event", async () => {
    const filePath = await temporaryPath("audit.jsonl");
    const sink = new JsonlAuditSink(filePath);
    const auditEvent = event({ contentHash: "hash-only" });

    await sink.record(auditEvent);

    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(auditEvent);
    if (false) {
      // @ts-expect-error The sink API must not accept raw content or metadata separately.
      void sink.record(auditEvent, { rawRequest: "forbidden" });
    }
  });
});
