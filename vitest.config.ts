import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    // DB-backed tests each spin up an in-memory pglite (WASM Postgres) instance;
    // under full-suite concurrency that startup can exceed the 5s default.
    testTimeout: 20000,
  },
});
