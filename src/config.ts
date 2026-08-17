import { z } from "zod";

const nonEmpty = z.string().trim().min(1);

const environmentSchema = z.object({
  MEM0_BASE_URL: z.string().url().default("http://127.0.0.1:8888"),
  MEM0_API_KEY: nonEmpty,
  MEM0_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(300_000).default(30_000),
  LUVIRA_SCOPE_TENANT: nonEmpty,
  LUVIRA_SCOPE_PROJECT: nonEmpty,
  LUVIRA_SCOPE_SUBJECT: nonEmpty,
  LUVIRA_HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
  LUVIRA_PORT: z.coerce.number().int().min(1).max(65_535).default(8765),
  LUVIRA_MCP_API_KEY: nonEmpty,
  LUVIRA_ALLOWED_ORIGINS: z.string().default(""),
  // Relative to process.cwd() by design: this resolves under the repository
  // root for bare-metal/Windows runs and under the container's /app WORKDIR
  // for Docker, landing in the same host-persistent `logs/` directory in
  // both cases without hardcoding an absolute path here.
  GOVERNANCE_AUDIT_PATH: nonEmpty.default("logs/governance-audit.jsonl"),
});

export interface AppConfig {
  mem0: {
    baseUrl: URL;
    apiKey: string;
    timeoutMs: number;
  };
  scope: {
    tenant: string;
    project: string;
    subject: string;
  };
  server: {
    host: string;
    port: number;
    apiKey: string;
    allowedOrigins: ReadonlySet<string>;
  };
  governance: {
    auditPath: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(env);
  return {
    mem0: {
      baseUrl: new URL(parsed.MEM0_BASE_URL),
      apiKey: parsed.MEM0_API_KEY,
      timeoutMs: parsed.MEM0_REQUEST_TIMEOUT_MS,
    },
    scope: {
      tenant: parsed.LUVIRA_SCOPE_TENANT,
      project: parsed.LUVIRA_SCOPE_PROJECT,
      subject: parsed.LUVIRA_SCOPE_SUBJECT,
    },
    server: {
      host: parsed.LUVIRA_HOST,
      port: parsed.LUVIRA_PORT,
      apiKey: parsed.LUVIRA_MCP_API_KEY,
      allowedOrigins: new Set(
        parsed.LUVIRA_ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean),
      ),
    },
    governance: {
      auditPath: parsed.GOVERNANCE_AUDIT_PATH,
    },
  };
}
