export type GatewayErrorCode =
  | "validation_error"
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "upstream_unavailable"
  | "upstream_timeout"
  | "upstream_contract_error"
  | "internal_error"
  // Memory Write Governance (Phase 3, AR-4): the write payload matched a
  // high-confidence secret pattern and was blocked before reaching Mem0.
  // The message shown to callers never includes the matched value.
  | "secret_detected_high_confidence";

export class GatewayError extends Error {
  constructor(
    public readonly code: GatewayErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}
