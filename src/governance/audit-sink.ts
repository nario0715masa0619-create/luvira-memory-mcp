import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { GovernanceAuditEvent } from "./types.js";

/**
 * Persists complete governance events supplied by its caller.
 *
 * The event-only API deliberately excludes Memory contents, raw requests,
 * metadata, and credentials. The caller remains responsible for creating the
 * event and deciding how a persistence failure affects a future write path.
 */
export interface AuditSink {
  record(event: GovernanceAuditEvent): Promise<void>;
}

/**
 * Persistent, append-only JSONL audit storage.
 *
 * Each event is serialized as one UTF-8 line. This sink does not make
 * governance decisions and is not tamper-proof. Calls are serialized within
 * this sink instance so concurrent callers do not lose events.
 */
export class JsonlAuditSink implements AuditSink {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  record(event: GovernanceAuditEvent): Promise<void> {
    const operation = this.pending.then(() => this.append(event));
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async append(event: GovernanceAuditEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    const file = await open(this.filePath, "a+");
    try {
      const { size } = await file.stat();
      let prefix = "";
      if (size > 0) {
        const lastByte = Buffer.alloc(1);
        await file.read(lastByte, 0, 1, size - 1);
        prefix = lastByte[0] === 0x0a ? "" : "\n";
      }
      await file.appendFile(`${prefix}${JSON.stringify(event)}`, "utf8");
    } finally {
      await file.close();
    }
  }
}
