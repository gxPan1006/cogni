#!/usr/bin/env node
// Release build of the desktop app with the REAL runner-host single binary as
// the Tauri `externalBin` sidecar (not the SP-1 dev shell wrapper). Produces a
// distributable .app/DMG that starts the daemon with no Node and no repo
// checkout on the target machine.
//
// Flow:
//   1. Compile the runner-host single binary (bun --compile, ad-hoc signed).
//   2. Copy it over the Tauri sidecar path (triple-suffixed name), replacing
//      the committed dev shell wrapper in the working tree.
//   3. Run `tauri build`.
//   4. ALWAYS restore the tracked dev wrapper (git checkout) so the working
//      tree stays clean and the 60MB binary never lands in git.
//
// Dev (`tauri dev`) is untouched — it keeps using the committed wrapper, which
// resolves dist/main.js from the repo.
//
// Usage: pnpm --filter desktop build:bundle

import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const repoRoot = resolve(appDir, "..", "..");
const runnerDir = join(repoRoot, "packages", "runner-host");
const builtBinary = join(runnerDir, "dist-bin", "cogni-runner-host");

const TRIPLE = "aarch64-apple-darwin"; // macOS arm64 only this slice
const sidecarPath = join(appDir, "src-tauri", "binaries", `cogni-runner-host-${TRIPLE}`);
const sidecarRel = relative(repoRoot, sidecarPath);

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

// 1. Compile the single binary.
run("pnpm", ["--filter", "@cogni/runner-host", "build:binary"], { cwd: repoRoot });

// 2. Place it on the Tauri sidecar path (overwriting the dev wrapper).
copyFileSync(builtBinary, sidecarPath);
chmodSync(sidecarPath, 0o755);
const mb = (statSync(sidecarPath).size / 1024 / 1024).toFixed(1);
console.log(`✓ placed ${mb} MB sidecar binary at ${sidecarRel}`);

// 3. Build, 4. always restore the tracked dev wrapper.
try {
  run("pnpm", ["tauri", "build"], { cwd: appDir });
} finally {
  console.log(`\nRestoring dev sidecar wrapper: git checkout -- ${sidecarRel}`);
  try {
    run("git", ["checkout", "--", sidecarRel], { cwd: repoRoot });
  } catch {
    console.error(`⚠ could not restore ${sidecarRel} — run: git checkout -- ${sidecarRel}`);
  }
}
