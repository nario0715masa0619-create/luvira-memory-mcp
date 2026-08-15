export type GatewayErrorCode =
  | "validation_error"
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "upstream_unavailable"
  | "upstream_timeout"
  | "upstream_contract_error"
  | "internal_error";

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
