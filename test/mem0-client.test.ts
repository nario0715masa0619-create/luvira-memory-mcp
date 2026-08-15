import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "../src/errors.js";
import { Mem0Client } from "../src/mem0-client.js";

function clientWith(fetchMock: typeof fetch): Mem0Client {
  return new Mem0Client({
    baseUrl: new URL("http://localhost:8888"),
    apiKey: "secret-key",
    timeoutMs: 1_000,
    fetch: fetchMock,
  });
}

describe("Mem0Client contract", () => {
  it("checks readiness through an authenticated read-only route", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    await clientWith(fetchMock).ready();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:8888/configure");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("X-API-Key")).toBe("secret-key");
  });

  it("calls the real create route with X-API-Key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const client = clientWith(fetchMock);
    await client.add({ messages: [{ role: "user", content: "hello" }], user_id: "scope" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:8888/memories");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("X-API-Key")).toBe("secret-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      messages: [{ role: "user", content: "hello" }],
      user_id: "scope",
    });
  });

  it.each([
    ["search", "POST", "http://localhost:8888/search"],
    ["get", "GET", "http://localhost:8888/memories/id%2Fwith%2Fslash"],
    ["update", "PUT", "http://localhost:8888/memories/id%2Fwith%2Fslash"],
    ["delete", "DELETE", "http://localhost:8888/memories/id%2Fwith%2Fslash"],
  ])("uses the real %s route", async (operation, method, expectedUrl) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const client = clientWith(fetchMock);
    if (operation === "search") await client.search({ query: "q", filters: { user_id: "scope" } });
    if (operation === "get") await client.get("id/with/slash");
    if (operation === "update") await client.update("id/with/slash", { text: "new" });
    if (operation === "delete") await client.delete("id/with/slash");
    expect(String(fetchMock.mock.calls[0]![0])).toBe(expectedUrl);
    expect(fetchMock.mock.calls[0]![1]?.method).toBe(method);
  });

  it("maps upstream auth errors without exposing the response body", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ detail: "secret internal detail" }), { status: 401 }),
    );
    await expect(clientWith(fetchMock).get("id")).rejects.toMatchObject({
      code: "unauthorized",
      message: "Mem0 authentication failed",
    } satisfies Partial<GatewayError>);
  });
});
