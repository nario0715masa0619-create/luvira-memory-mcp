import { GatewayError } from "./errors.js";

export interface Mem0Message {
  role: "user" | "assistant";
  content: string;
}

export interface AddMemoryRequest {
  messages: Mem0Message[];
  user_id: string;
  metadata?: Record<string, unknown> | undefined;
  expiration_date?: string | undefined;
  infer?: boolean | undefined;
  memory_type?: string | undefined;
}

export interface SearchMemoryRequest {
  query: string;
  filters: Record<string, unknown>;
  top_k?: number | undefined;
  threshold?: number | undefined;
  explain?: boolean | undefined;
  show_expired?: boolean | undefined;
}

export interface UpdateMemoryRequest {
  text?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
  expiration_date?: string | null | undefined;
}

export interface Mem0ClientOptions {
  baseUrl: URL;
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export class Mem0Client {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: Mem0ClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async ready(): Promise<void> {
    await this.request("GET", "configure");
  }

  add(input: AddMemoryRequest): Promise<unknown> {
    return this.request("POST", "memories", input);
  }

  search(input: SearchMemoryRequest): Promise<unknown> {
    return this.request("POST", "search", input);
  }

  get(memoryId: string): Promise<unknown> {
    return this.request("GET", `memories/${encodeURIComponent(memoryId)}`);
  }

  update(memoryId: string, input: UpdateMemoryRequest): Promise<unknown> {
    return this.request("PUT", `memories/${encodeURIComponent(memoryId)}`, input);
  }

  delete(memoryId: string): Promise<unknown> {
    return this.request("DELETE", `memories/${encodeURIComponent(memoryId)}`);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const url = new URL(path, ensureTrailingSlash(this.options.baseUrl));
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          "X-API-Key": this.options.apiKey,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const payload = await parseResponse(response);
      if (!response.ok) throw mapHttpError(response.status);
      return payload;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new GatewayError("upstream_timeout", "Mem0 request timed out", true);
      }
      throw new GatewayError("upstream_unavailable", "Mem0 is unavailable", true);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function ensureTrailingSlash(url: URL): URL {
  const copy = new URL(url);
  if (!copy.pathname.endsWith("/")) copy.pathname += "/";
  return copy;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GatewayError("upstream_contract_error", "Mem0 returned invalid JSON", false, response.status);
  }
}

function mapHttpError(status: number): GatewayError {
  if (status === 401 || status === 403) return new GatewayError("unauthorized", "Mem0 authentication failed", false, status);
  if (status === 404) return new GatewayError("not_found", "Memory not found", false, status);
  if (status === 429) return new GatewayError("rate_limited", "Mem0 rate limit exceeded", true, status);
  if (status >= 400 && status < 500) return new GatewayError("validation_error", "Mem0 rejected the request", false, status);
  return new GatewayError("upstream_unavailable", "Mem0 request failed", true, status);
}
