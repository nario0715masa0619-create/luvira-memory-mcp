import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
    // MCP transport shutdown can race Vitest worker IPC on Windows. Serial files
    // keep lifecycle cleanup deterministic without changing test coverage.
    fileParallelism: false,
  },
});
