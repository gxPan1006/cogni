import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the workspace library packages to their TypeScript source. Their
// package.json `main` points at `dist/`, which is gitignored and not built on a
// fresh checkout — without these aliases, any test whose module graph reaches a
// *value* import of @cogni/contract or @cogni/shared fails to resolve. vitest
// transforms the .ts source on the fly, so tests need no build step.
export default defineConfig({
  resolve: {
    alias: {
      "@cogni/contract": fileURLToPath(new URL("./packages/contract/src/index.ts", import.meta.url)),
      "@cogni/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    // DB-backed tests each spin up an in-memory pglite (WASM Postgres) instance;
    // under full-suite concurrency that startup can exceed the 5s default.
    testTimeout: 20000,
  },
});
