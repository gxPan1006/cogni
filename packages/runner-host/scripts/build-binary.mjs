#!/usr/bin/env node
// Compile the runner-host into a self-contained single binary via `bun build
// --compile`. Embeds the JS + npm deps (execa/ws/zod/@cogni/*) + the Bun
// runtime, so the produced binary needs neither Node nor the repo checkout on
// the target machine. The agent CLIs it spawns (claude/codex/git) stay
// external and are resolved from PATH at runtime, unchanged.
//
// Why this exists: the SP-1 sidecar was a shell wrapper that `exec node`'d
// dist/main.js by walking up to the repo — so a `.app` outside the repo could
// never start the daemon. See
// docs/superpowers/specs/2026-05-20-runner-host-single-binary-sidecar-design.md
//
// Usage: pnpm --filter @cogni/runner-host build:binary
// Output: packages/runner-host/dist-bin/cogni-runner-host (gitignored)

import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "..");
const repoRoot = resolve(pkgDir, "..", "..");
const outDir = join(pkgDir, "dist-bin");
const outFile = join(outDir, "cogni-runner-host");

// macOS arm64 only for this slice (see spec "Out of scope").
const TARGET = "bun-darwin-arm64";

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

// 1. Build workspace dist/ so bun resolves @cogni/contract + @cogni/shared
//    (their package.json `main` points at dist/index.js) plus our own dist.
run("pnpm", ["build"], { cwd: repoRoot });

// 2. Compile to a single binary.
mkdirSync(outDir, { recursive: true });
run("bun", [
  "build",
  join(pkgDir, "src", "main.ts"),
  "--compile",
  `--target=${TARGET}`,
  "--outfile",
  outFile,
]);

// 3. Ad-hoc codesign — without a signature macOS Gatekeeper kills the nested
//    sidecar binary inside the .app ("damaged / can't be opened").
if (process.platform === "darwin") {
  run("codesign", ["--sign", "-", "--force", "--timestamp=none", outFile]);
}

const sizeMb = (statSync(outFile).size / 1024 / 1024).toFixed(1);
console.log(`\n✓ built ${outFile} (${sizeMb} MB)`);
