# Runner-host single-binary sidecar (macOS arm64)

**Date:** 2026-05-20
**Status:** approved, implementing
**Scope:** SP-4 sidecar packaging — first slice (macOS arm64 only)

## Problem

The desktop `.app` bundles the runner-host daemon as an `externalBin`
sidecar (`apps/desktop/src-tauri/tauri.conf.json` →
`"externalBin": ["binaries/cogni-runner-host"]`). Today that "binary" is an
**SP-1 stopgap shell script**
(`apps/desktop/src-tauri/binaries/cogni-runner-host-aarch64-apple-darwin`,
792 bytes) that walks parent directories looking for
`packages/runner-host/dist/main.js` and `exec node`s it.

Consequences:

- The `.app` only works **inside the repo checkout**. Drag it to
  `/Applications` (or onto another machine) and the upward search never finds
  `dist/main.js` → the daemon never starts → the host shows perpetually
  offline. The DMG is therefore good for local dev verification but **not
  distributable** — which is the whole point of producing a DMG.
- It requires the end user to have **Node installed on PATH**.

The launchd persistence path (`packages/runner-host/scripts/install-launchd.sh`,
done + verified in `3ffd88c`) has the same two dependencies — it runs
`node dist/main.js` from the repo. It is **out of scope** here and left
untouched (an opt-in power-user alternative).

## Goal

Replace the stopgap shell script with a **self-contained single binary** so a
`.app`/DMG launched from anywhere starts the runner-host daemon with **no Node
runtime and no repo checkout** required on the target machine.

## Decisions (locked with user 2026-05-20)

| Question | Decision |
| --- | --- |
| Packaging tool | **Bun `--compile`** — one step bundles JS + deps + runtime; native ESM. |
| Daemon lifecycle | **App-managed sidecar** (existing `daemon.rs` model) — daemon is tied to app lifetime. launchd left as-is, not made canonical. |
| Target platforms | **macOS arm64 only** (`aarch64-apple-darwin`) this slice. Windows/Linux later. |

## Why Bun over Node SEA

The runner-host is ESM and spawns external CLIs (`claude`, `codex`, `git`) via
`execa` rather than importing them — so the binary only needs to embed the
runner-host's own JS, its npm deps (`execa`, `ws`, `zod`, `@cogni/contract`,
`@cogni/shared`), and a JS runtime. Bun `build --compile` does bundle + runtime
embed in a single command with first-class ESM support. Node SEA needs an
esbuild→CJS pre-bundle, a `postject` blob injection into a copied `node`, and
codesign — more moving parts, a larger (~80MB) binary, and awkward
cross-compilation. Risk accepted: the binary runs under the **Bun** runtime,
not Node, so Node-compat edge cases (subprocess spawning via execa, the `ws`
client) must be verified early (see Acceptance).

## Components

### 1. `packages/runner-host/scripts/build-binary.mjs`

A Node script (run via `pnpm --filter @cogni/runner-host build:binary`) that:

1. Ensures `pnpm build` ran (workspace `dist/` present for runner-host +
   `@cogni/contract` + `@cogni/shared`). It shells `pnpm build` itself so the
   step is self-contained.
2. Runs `bun build src/main.ts --compile --target=bun-darwin-arm64 --outfile <out>/cogni-runner-host`.
3. Ad-hoc codesigns the output: `codesign --sign - --force --timestamp=none <out>/cogni-runner-host`.
   Without a signature Gatekeeper kills the nested binary ("damaged").
4. Prints the output path + size.

Output goes to `packages/runner-host/dist-bin/cogni-runner-host` (gitignored).

### 2. `apps/desktop` wiring — `build:bundle` script

`apps/desktop/package.json` gains:

```
"build:bundle": "node scripts/place-sidecar.mjs && pnpm tauri build"
```

`apps/desktop/scripts/place-sidecar.mjs`:

1. Invokes the runner-host `build:binary` step.
2. Copies `packages/runner-host/dist-bin/cogni-runner-host` →
   `apps/desktop/src-tauri/binaries/cogni-runner-host-aarch64-apple-darwin`
   (the Tauri triple-suffixed name), `chmod +x`.

Tauri's existing `beforeBuildCommand` (`pnpm build`, builds the frontend) is
unchanged — `place-sidecar.mjs` runs before `tauri build` is invoked.

### 3. gitignore + dev vs release split

- `.gitignore`: add `packages/runner-host/dist-bin/` and
  `apps/desktop/src-tauri/binaries/cogni-runner-host-aarch64-apple-darwin`.
- **Dev (`tauri dev`)**: keeps using the committed shell-script wrapper — it
  resolves `dist/main.js` from the repo, which is exactly right for dev and
  avoids a ~5s bun compile on every iteration. The wrapper stays tracked in
  git.
- **Release (`build:bundle`)**: the shell wrapper stays **tracked** at the
  triple name (it is the dev default — do NOT gitignore that exact path).
  `place-sidecar.mjs` copies the real bun binary over it just before
  `tauri build`, then restores the tracked wrapper via
  `git checkout -- <path>` when the build finishes, so the working tree is
  clean again and the 60MB binary never touches git. `dist-bin/` (the bun
  compile output) is gitignored.

## Data flow (unchanged at runtime)

`daemon.rs::ensure_daemon` → `app.shell().sidecar("cogni-runner-host").spawn()`
→ (release) the real bun binary boots, reads `~/.cogni/host.json`, connects to
cloud, registers adapters. Identical to today except the process is now a
self-contained binary instead of `node dist/main.js`.

## Acceptance criteria

1. **Binary connects (Bun-runtime smoke test).** `dist-bin/cogni-runner-host`
   run standalone with a valid `~/.cogni/host.json` connects to the cloud and
   the host shows online. Proves `ws` + `execa` work under Bun. *If this fails,
   stop and fall back to Node SEA.*
2. **Distributable `.app`.** Build via `build:bundle`, copy `Cogni.app` **out
   of the repo** (e.g. `/tmp/Cogni.app` or `/Applications`), launch it,
   register/sign in, and confirm the sidecar spawns and the host goes online —
   the exact scenario the stopgap fails. Verified on the real machine.
3. **No 60MB artifact committed.** `git status` clean after a release build;
   `git ls-files` shows no binary.

## Out of scope

- Windows / Linux binaries (`daemon.rs` Windows `is_alive` stopgap stays).
- launchd → binary migration (script left pointing at `node dist/main.js`).
- `daemon.rs` liveness hardening (PID-recycle false-positive).
- Notarization / Developer ID signing (ad-hoc only; Gatekeeper quarantine on
  download-from-internet is a later distribution concern).
</content>
</invoke>
