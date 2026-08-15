import { redact } from "./redaction.js";

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

function emit(level: "info" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const record = redact({ timestamp: new Date().toISOString(), level, event, ...fields });
  const output = JSON.stringify(record);
  if (level === "error") process.stderr.write(`${output}\n`);
  else process.stdout.write(`${output}\n`);
}

export const logger: Logger = {
  info: (event, fields) => emit("info", event, fields),
  error: (event, fields) => emit("error", event, fields),
};
