import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { redact, REDACTED } from "../src/redaction.js";

const validEnv = {
  MEM0_API_KEY: "mem0-secret",
  LUVIRA_SCOPE_TENANT: "personal",
  LUVIRA_SCOPE_PROJECT: "shared",
  LUVIRA_SCOPE_SUBJECT: "owner",
  LUVIRA_MCP_API_KEY: "gateway-secret",
};

describe("configuration", () => {
  it("loads safe defaults and the trusted scope", () => {
    const config = loadConfig(validEnv);
    expect(config.mem0.baseUrl.href).toBe("http://127.0.0.1:8888/");
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.scope).toEqual({ tenant: "personal", project: "shared", subject: "owner" });
  });

  it("allows the wildcard container bind address", () => {
    const config = loadConfig({ ...validEnv, LUVIRA_HOST: "0.0.0.0" });
    expect(config.server.host).toBe("0.0.0.0");
  });

  it("requires the Mem0 API key and all scope components", () => {
    expect(() => loadConfig({})).toThrow();
  });

  it("defaults authRegistry.required to false when unset", () => {
    expect(loadConfig(validEnv).authRegistry.required).toBe(false);
  });

  it("keeps authRegistry.required false when explicitly set to \"false\"", () => {
    expect(loadConfig({ ...validEnv, LUVIRA_AUTH_REGISTRY_REQUIRED: "false" }).authRegistry.required).toBe(false);
  });

  it("sets authRegistry.required true when explicitly set to \"true\"", () => {
    expect(loadConfig({ ...validEnv, LUVIRA_AUTH_REGISTRY_REQUIRED: "true" }).authRegistry.required).toBe(true);
  });
});

describe("redaction", () => {
  it("redacts secrets recursively without changing ordinary fields", () => {
    expect(redact({ authorization: "Bearer x", nested: { api_key: "y", status: 401 } })).toEqual({
      authorization: REDACTED,
      nested: { api_key: REDACTED, status: 401 },
    });
  });
});
