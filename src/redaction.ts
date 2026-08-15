const SENSITIVE_KEY = /api[-_]?key|authorization|token|secret|password/i;

export const REDACTED = "[REDACTED]";

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, SENSITIVE_KEY.test(key) ? REDACTED : redact(nested)]),
    );
  }
  return value;
}
