# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Cogni's slogan is **"brain in the cloud, hands on the local machine"**: a cloud
control plane owns accounts/data/orchestration, and a desktop-side **Runner
Host** daemon runs agent runners (Claude Code today, Codex experimentally) on
the user's own machine. Chat / project events stream over WebSocket between
the two.

This repository is the SP-1 → SP-3 implementation. See
[`README.md`](README.md) for the roadmap and
[`docs/superpowers/specs/2026-05-14-cogni-sp1-spine-design.md`](docs/superpowers/specs/2026-05-14-cogni-sp1-spine-design.md)
for the canonical design doc. Running it locally — Neon / Google OAuth /
magic-link setup, build steps, the acceptance checklist — is documented in
[`docs/RUNNING.md`](docs/RUNNING.md); refer to it instead of inventing run recipes.

## Workspace layout (pnpm monorepo)

`pnpm-workspace.yaml` resolves `packages/*` and `apps/*`. Workspace names:

| Path | npm name | Role |
| --- | --- | --- |
| `packages/contract` | `@cogni/contract` | Shared zod schemas / TS types. **No runtime deps on other workspaces.** Defines: `RunnerAdapter` + `RunnerEvent` (runner abstraction); `hostToCloud` / `cloudToHost` / `clientToCloud` / `cloudToClient` protocol unions; `hostRpcRequest` / `hostRpcResponse` for SP-3 cloud→host RPC (git-ops, fs-browse, generate-title); domain types (threads, projects, tasks). |
| `packages/shared` | `@cogni/shared` | Tiny internal utilities (today: a pino logger). Re-imported everywhere. |
| `packages/cloud` | `@cogni/cloud` | Cloud control plane: Hono + `@hono/node-ws` server, Neon + drizzle data layer, Google OAuth + magic-link auth, `HostRouter` / `ClientHub` connection registries, `ChatDomain`, `ProjectDomain` (SP-3 orchestrator + lifecycle + merge-gate), email transport (console / Resend / SMTP). Entry: `src/main.ts` → `src/server.ts`. |
| `packages/runner-host` | `@cogni/runner-host` | Desktop daemon: registers with cloud via `~/.cogni/host.json`, manages runner adapters (`adapters/claude-code.ts`, `adapters/codex/*`), dispatches host-RPC requests for git-ops + fs-browse + thread-title generation. Entry: `src/main.ts`. |
| `packages/ui` | `@cogni/ui` | React 19 component + hooks library shared by desktop and web. `main`/`types` point at `src/index.ts` (no build step) — consumers Vite-transform it on demand. |
| `apps/desktop` | `desktop` *(unscoped!)* | Tauri 2 + React app. Owns deep-link OAuth callback, daemon spawn/register. Filter is `pnpm --filter desktop ...`, **not** `@cogni/desktop`. |
| `apps/web` | `web` *(unscoped!)* | React + react-router SPA (chat.ai-cognit.com in prod). Same UI components as desktop via `@cogni/ui`. |

## Common commands (run from repo root)

```sh
pnpm install                 # one-time / after lockfile change
pnpm build                   # tsc -b across packages/* (writes dist/)
pnpm typecheck               # = pnpm build && pnpm -r typecheck
pnpm test                    # vitest run (all *.test.ts under packages/*/src)
pnpm lint                    # eslint .
pnpm ci                      # what GitHub Actions runs: build + typecheck + vitest on cloud+contract (no file parallelism)

# Single test file / single test
pnpm vitest run packages/cloud/src/domains/chat.test.ts
pnpm vitest run -t "name of the test case"

# Per-package
pnpm --filter @cogni/cloud dev        # tsx watch --env-file=.env src/main.ts (port 8787)
pnpm --filter @cogni/cloud exec drizzle-kit push   # apply schema to Neon
pnpm --filter desktop tauri dev       # Tauri dev (HMR vite + cargo build)
pnpm --filter desktop build           # tsc + vite build, no Tauri bundle
pnpm --filter web dev                 # vite, port 5173
```

The CI workflow (`.github/workflows/ci.yml`) pins `pnpm@10.33.0` via corepack
and runs on Node 22 — match these locally to reproduce CI failures.

## Critical conventions

- **Built `dist/` is the package entry.** Every `packages/*` `package.json`
  has `"main": "./dist/index.js"`. `dist/` is gitignored. Consequences:
  - `pnpm --filter @cogni/cloud dev` (tsx) and the runner-host sidecar
    (`node dist/main.js`) both **need a prior `pnpm build`**. Re-run after
    editing any `packages/*` source.
  - `pnpm test` does **not** need a build — `vitest.config.ts` aliases
    `@cogni/contract` and `@cogni/shared` to their `src/index.ts` so vitest
    transforms source on the fly. `pnpm typecheck` builds first, then
    `tsc --noEmit` across all packages.
- **`noUncheckedIndexedAccess: true` + `verbatimModuleSyntax: true`** are on
  globally (see `tsconfig.base.json`). Treat array / record lookups as
  `T | undefined`; use `import type` for type-only imports — these are
  load-bearing and CI will catch regressions.
- **DB-backed tests use pglite (WASM Postgres) in-memory** — no external DB
  needed. Each test spins up its own instance, so the vitest `testTimeout`
  is 20s. Tests live next to source as `*.test.ts`.
- **The runner abstraction is the boundary**, not an implementation detail.
  Anything runner-specific (Claude session ids, codex quirks) belongs behind
  `RunnerAdapter` in `packages/runner-host/src/adapters/*`. The cloud only
  knows the `RunnerEvent` discriminated union from `@cogni/contract`.
- **Two WebSocket "sides".** The cloud has one WS for runner hosts
  (`routes/host-ws.ts` + `HostRouter`) and one for client apps
  (`routes/client.ts` + `ClientHub`). Domains (chat, project) dispatch host
  work via `HostRouter`, broadcast UI updates via `ClientHub`. SP-3 added
  cloud→host RPC over the same host WS, with `rpcId` correlation.
- **`packages/ui` does not build.** Its exports point at TS source. Both
  `apps/desktop` and `apps/web` Vite-transform it — don't add `tsc` build
  output assumptions to UI code.
- **No `CLAUDE.md` in `packages/*` today.** Architectural notes live in
  `docs/superpowers/specs/` and `docs/superpowers/plans/`; ad-hoc context in
  `MEMORY.md`, `HANDOFF-NOTES.md`, `tbd.md`. Read these before
  proposing structural changes.

## Verifying user-visible changes

`MEMORY.md` documents a recurring trap: after a desktop / cloud change the
user re-tests against a *stale* process (an old `Cogni.app` bundle, a
PPID=1 orphaned `target/debug/desktop` binary, a second `vite` from another
worktree). Before declaring a UI / streaming fix "done":

1. Grep processes from **both** angles — `ps -ef | grep -iE "tauri|cargo|vite|Cogni\.app"` and `ps -ef | grep -E "target/(debug|release)/(desktop|cogni)"` — and inspect PPID=1 orphans.
2. Confirm which client the user will hit (`pnpm --filter web dev` vs prod web vs `pnpm --filter desktop tauri dev` vs a built `Cogni.app`) and whether it's running the new code.
3. Kill stale instances before asking the user to retest; tell them exactly which window and which reload key (`Cmd+R` in the Tauri webview).

Full lesson + the 2026-05-18 incident that prompted it is in `MEMORY.md`.
