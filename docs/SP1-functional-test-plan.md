# Cogni SP-1 — Functional Test Plan

> **For the tester (ChatGPT or a human):** This is a standalone test plan for the
> Cogni SP-1 "walking skeleton". Execute the test cases you can, verify the rest by
> code inspection, then fill in the **Test Report** template at the end (§4). You do
> not need any prior context — §1 tells you what the system is.

---

## 1. What you're testing

**Cogni** is a unified personal-assistant + AI-worker product. **SP-1** is its first
milestone: a *walking skeleton* that punches one minimal end-to-end loop through four
architectural pillars — **account/auth, data persistence, a decoupled runner
abstraction, and a cloud↔desktop topology**.

The intended end-to-end behavior:
> Desktop login → user sends a message in a chat → the cloud routes it to the user's
> local Runner Host → Claude Code runs there → output streams back → everything is
> persisted in Neon (Postgres).

**Monorepo layout** (pnpm workspace, TypeScript/Node + Rust for the desktop shell):

| Package | Responsibility |
|---|---|
| `packages/contract` | The only cross-package coupling surface: the `RunnerAdapter` abstraction + capability list, the 4 WebSocket protocol schemas (`HostToCloud`/`CloudToHost`/`ClientToCloud`/`CloudToClient`), `RunnerEvent`, domain view types. All as zod schemas + inferred types. |
| `packages/cloud` | Hono control plane: Neon/drizzle data layer (7 tables), `HostRouter` + `ClientHub`, `ChatDomain` orchestrator, Google OAuth + JWT auth, host-WS + client-WS endpoints, a headless end-to-end "spine" test. |
| `packages/runner-host` | The independent desktop daemon: `~/.cogni/host.json` config, the Claude Code adapter (parses `claude` stream-json → `RunnerEvent`s), `RunnerManager`, the cloud registry client (WS, reconnect-with-backoff). |
| `packages/shared` | A pino logger. |
| `apps/desktop` | Tauri 2 + React UI: deep-link Google OAuth, the app shell + sidebar (chat/项目 toggle, Recents), the streaming conversation view, and the Rust commands that register + spawn the runner-host daemon. |

**Data flow of the spine:** desktop `useThreadStream.send` → client-WS → `ChatDomain.handleClientSend`
→ persist + `HostRouter` → host-WS → runner-host registry `handleDispatch` → `RunnerManager.dispatch`
→ `ClaudeCodeAdapter` → `RunnerEvent`s back up the same chain → `ChatDomain.handleHostEvent`
→ `ClientHub` fan-out → desktop renders.

**Known SP-1 stopgaps (NOT bugs — deliberate, deferred to later milestones):** the
runner-host sidecar is a shell-script wrapper (not a true OS-login daemon); OAuth login
state is single-node in-memory; host events have no per-session ownership check; one
tenant per user; the 项目 (project) mode is disabled. These are documented in code
comments and the design spec — do not file them as defects, but you may note them.

---

## 2. Test environment & tiers

Tests fall into three tiers. Mark each result with which tier it was run as.

| Tier | Marker | What it needs | Who can run it |
|---|---|---|---|
| **Automated** | `[AUTO]` | Just the repo + Node ≥20.10 + pnpm + Rust toolchain. No network, no DB, no GUI. | Anyone with the repo. The objective backbone. |
| **Code inspection** | `[CODE]` | The repo source only. Verify a guard/behavior exists by reading the code. | Anyone (incl. ChatGPT reading the repo). |
| **Manual / live** | `[MANUAL]` | A real Neon DB + Google OAuth credentials + a desktop GUI + the `claude` CLI installed & authenticated. | A human at a Mac. |

### 2.1 Setup for `[AUTO]` / `[CODE]`

```sh
# from the repo root
pnpm install
pnpm build          # builds the 4 library packages into dist/
```

### 2.2 Setup for `[MANUAL]` (live end-to-end)

Follow `docs/RUNNING.md` in full: create a Neon project + `pnpm --filter @cogni/cloud exec drizzle-kit push`;
create Google OAuth Web credentials (redirect URI `http://localhost:8787/auth/google/callback`);
fill `packages/cloud/.env`; `pnpm build`; then run `pnpm --filter @cogni/cloud dev` (Terminal 1)
and `pnpm --filter desktop tauri dev` (Terminal 2). The `claude` CLI must be installed and logged in.

### 2.3 Which automated test files cover which area

`pnpm test` runs **18 test files / 84 tests**. Map:

- `packages/contract/src/runner.test.ts`, `protocol.test.ts` → Area B
- `packages/cloud/src/db/*.test.ts` (schema, users, hosts, threads, sessions) → Area C
- `packages/cloud/src/host-router.test.ts`, `client-hub.test.ts`, `domains/chat.test.ts` → Area D
- `packages/cloud/src/auth.test.ts`, `env.test.ts`, `routes/auth.test.ts`, `server.e2e.test.ts` → Area E
- `packages/runner-host/src/*.test.ts` (config, adapters/claude-code, runner-manager, registry) → Area F

---

## 3. Test cases

Each case: **ID · Title · [Tier] · Priority** then **Steps** / **Expected**. Record
**Actual** + **Status** (PASS / FAIL / BLOCKED / NOT-RUN) in the report.

### Area A — Build & automated verification (the objective backbone)

**A1 · Dependencies install · [AUTO] · P0**
- Steps: `pnpm install` from repo root.
- Expected: completes with no error; a `pnpm-lock.yaml` is present and unchanged.

**A2 · Library packages build · [AUTO] · P0**
- Steps: `pnpm build`.
- Expected: `contract`, `shared`, `cloud`, `runner-host` all report build "Done"; each gets a `dist/`.

**A3 · Typecheck · [AUTO] · P0**
- Steps: `pnpm typecheck`.
- Expected: all 5 TS projects (contract, shared, cloud, runner-host, **desktop**) report "Done", zero type errors.

**A4 · Full test suite · [AUTO] · P0**
- Steps: `pnpm test`.
- Expected: **18 test files passed, 84 tests passed, 0 failed.** (One benign warn line —
  `"host-ws onClose failed" / "PGlite is closed"` — appears during the cloud e2e test's
  teardown; it is a documented harmless artifact, the test still passes.)

**A5 · Desktop frontend build · [AUTO] · P1**
- Steps: `pnpm --filter desktop build`.
- Expected: `tsc` clean, `vite build` succeeds (~40 modules transformed, a JS bundle emitted).

**A6 · Desktop Rust shell compiles · [AUTO] · P1**
- Steps: `cd apps/desktop/src-tauri && cargo check`.
- Expected: `Finished` with no errors. (First run is slow — it compiles the Tauri plugin crates.)

**A7 · Fresh-checkout resilience · [AUTO] · P1**
- Steps: delete every `dist/` and `*.tsbuildinfo` under `packages/` + `apps/`, then run `pnpm test`.
- Expected: still **84/84 pass** — the test runner resolves the workspace packages from
  source (vitest alias), so tests need no prior build.

### Area B — Contract package (protocol & types)

**B1 · RunnerEvent schema · [AUTO] · P0**
- Steps: `pnpm vitest run packages/contract/src/runner.test.ts`.
- Expected: 14 tests pass — every one of the 7 `RunnerEvent` variants (`session-id`, `text`,
  `tool-call`, `tool-result`, `permission-request`, `done`, `error`) is accepted, and
  malformed/unknown events are rejected.

**B2 · WS protocol schemas · [AUTO] · P0**
- Steps: `pnpm vitest run packages/contract/src/protocol.test.ts`.
- Expected: 20 tests pass — all 4 discriminated-union message schemas
  (`hostToCloud`/`cloudToHost`/`clientToCloud`/`cloudToClient`) parse valid messages
  and reject invalid tags / missing fields / wrong status values.

**B3 · Single coupling surface · [CODE] · P1**
- Steps: grep `cloud`, `runner-host`, `apps/desktop` for protocol/event type definitions.
- Expected: no package re-defines `HostToCloud`/`RunnerEvent`/etc. locally — they all import from `@cogni/contract`.

### Area C — Cloud data layer (Neon/drizzle repositories)

**C1 · Schema + in-memory test DB · [AUTO] · P0**
- Steps: `pnpm vitest run packages/cloud/src/db/schema.test.ts`.
- Expected: pglite harness creates all 7 tables; a tenant round-trips with a UUID id.

**C2 · User/tenant repository · [AUTO] · P0**
- Steps: `pnpm vitest run packages/cloud/src/db/users.test.ts`.
- Expected: `findOrCreateUser` is idempotent on `oauthSub` (second call returns the same user + tenant).

**C3 · Host repository · [AUTO] · P0**
- Steps: `pnpm vitest run packages/cloud/src/db/hosts.test.ts`.
- Expected: `createHost` mints a **64-hex-char** registration token; `findHostByToken`
  resolves it; `setHostStatus` updates status; a no-capabilities status update (heartbeat)
  does **not** wipe the host's stored capabilities.

**C4 · Thread / message repository + ownership · [AUTO] · P0**
- Steps: `pnpm vitest run packages/cloud/src/db/threads.test.ts`.
- Expected: create/list/detail/append/touch all work; `listThreads` is most-recently-updated-first;
  `getThreadDetail` returns `null` for an unknown id; **`threadBelongsToUser` returns true only
  for the owner**, false for another user and for a nonexistent thread.

**C5 · Runner-session / event repository · [AUTO] · P0**
- Steps: `pnpm vitest run packages/cloud/src/db/sessions.test.ts`.
- Expected: exactly one `runner_session` per thread (reused); `appendEvent` assigns a
  **monotonic per-thread `seq` starting at 1**; `listEventsSince` filters `seq > N`;
  `runnerSessionId`/`status` persist.

### Area D — Cloud domain logic (routing + orchestration)

**D1 · HostRouter · [AUTO] · P0**
- Steps: `pnpm vitest run packages/cloud/src/host-router.test.ts`.
- Expected: registers a host & finds it for the user; `getHostForUser` is null after unregister;
  re-registering the same user with a new host evicts the old one.

**D2 · ClientHub · [AUTO] · P0**
- Steps: `pnpm vitest run packages/cloud/src/client-hub.test.ts`.
- Expected: `broadcast` reaches only clients subscribed to that thread; `unregister` stops
  delivery; `subscribe` from an unregistered client is ignored (no ghost entry); `sendToUser`
  is scoped to that user only.

**D3 · ChatDomain orchestrator · [AUTO] · P0**
- Steps: `pnpm vitest run packages/cloud/src/domains/chat.test.ts`.
- Expected: with no online host → the user message is still persisted and a
  `host-status: false` is broadcast. With a host → a full turn walks
  `dispatch → session-id → text → done`, the assistant reply is persisted as a message,
  the fanned-out events carry monotonic `seq` `[1,2,3]`, and a **second** message resumes
  with the stored `runnerSessionId`. If `host.send` throws → the session is marked `failed`
  and clients are told the host is offline.

### Area E — Cloud server, auth & the end-to-end spine

**E1 · Headless end-to-end spine · [AUTO] · P0 — THE KEY INTEGRATION TEST**
- Steps: `pnpm vitest run packages/cloud/src/server.e2e.test.ts`.
- Expected: a real Hono server boots on a real socket; a fake Runner Host and a fake UI
  client connect over real WebSockets; the client `subscribe`s → gets `host-status: true`;
  the client sends "hi" → the host receives a `dispatch` → the host streams
  `session-id`/`text`/`done` → the client receives the user echo + the 3 events + the
  assistant message → the DB ends with messages `["user:hi", "assistant:hello"]`. **This
  proves the whole spine wires together.** Run it 2-3× — it must be non-flaky.

**E2 · JWT auth · [AUTO] · P0**
- Steps: `pnpm vitest run packages/cloud/src/auth.test.ts`.
- Expected: a session token round-trips (issue → verify → same claims); a tampered token
  and garbage both verify to `null`.

**E3 · Env loader fail-fast · [AUTO] · P1**
- Steps: `pnpm vitest run packages/cloud/src/env.test.ts`.
- Expected: `loadEnv` throws on a missing required var; defaults `PUBLIC_URL`/`PORT`;
  throws on a non-numeric `PORT`.

**E4 · OAuth open-redirect guard · [AUTO] · P0 (security)**
- Steps: `pnpm vitest run packages/cloud/src/routes/auth.test.ts`.
- Expected: `safeRedirect` allows only the `cogni://` deep-link scheme; `https://evil.com`,
  `http://localhost/steal`, malformed input, and empty all fall back to the default
  `cogni://auth`. (This guards against leaking the session token to an attacker URL.)

**E5 · `.env` is actually loaded by the cloud dev server · [MANUAL] · P1**
- Steps: with a filled `packages/cloud/.env`, run `pnpm --filter @cogni/cloud dev`.
- Expected: the server logs `"cloud control plane listening"` — it does NOT crash with
  `Missing env var: DATABASE_URL` (the `dev` script loads `.env` via `tsx --env-file`).

### Area F — Runner-host (the desktop daemon)

**F1 · Host config · [AUTO] · P0**
- Steps: `pnpm vitest run packages/runner-host/src/config.test.ts`.
- Expected: `readHostConfig` returns `null` when no file exists, round-trips a written config,
  and returns `null` (does not throw) on broken JSON or a config missing required fields;
  `threadScratchDir` derives `<COGNI_HOME>/threads/<id>`.

**F2 · Claude Code adapter · [AUTO] · P0**
- Steps: `pnpm vitest run packages/runner-host/src/adapters/claude-code.test.ts`.
- Expected: declares id `claude-code` + capabilities `[streaming, session-resume, tool-events]`;
  translates a full `claude` stream-json turn into the event sequence
  `[session-id, text, tool-call, tool-result, session-id, done]`; a non-success result
  subtype maps to an `error` event; a stream with no `result` line synthesizes a `done`;
  `resumeSession` seeds `runnerSessionId`.

**F3 · Runner manager · [AUTO] · P0**
- Steps: `pnpm vitest run packages/runner-host/src/runner-manager.test.ts`.
- Expected: `dispatch` routes to the named adapter and forwards every event; uses
  `resumeSession` when a `runnerSessionId` is given; an unknown adapter yields a single
  `error` event (`unknown_adapter`); `capabilities()` returns the deduped union.

**F4 · Cloud registry dispatch handler · [AUTO] · P0**
- Steps: `pnpm vitest run packages/runner-host/src/registry.test.ts`.
- Expected: `handleDispatch` forwards each `RunnerEvent` as an `event` message then a
  terminal `session-update` — `completed` on success, `failed` when an `error` event occurred.

### Area G — Desktop app (build-level + code inspection)

**G1 · Desktop builds & compiles · [AUTO] · P0**
- Covered by A5 + A6. Confirm both pass.

**G2 · Auth flow wiring · [CODE] · P1**
- Steps: read `apps/desktop/src/useAuth.ts`, `Login.tsx`, `App.tsx`.
- Expected: `login()` opens the system browser to `/auth/google/start?redirect=cogni://auth`;
  a `cogni://` deep link is caught and its `?token=` stored in `localStorage`; `App.tsx`
  routes to `<Login>` when there's no token, `<Shell>` when there is.

**G3 · API client error model · [CODE] · P1 (security/robustness)**
- Steps: read `apps/desktop/src/api.ts`.
- Expected: every method goes through a `request()` helper that checks `res.ok` and throws
  a typed `ApiError` (with `.status`) on a non-2xx response — it never silently returns error JSON.

**G4 · Shell resilience · [CODE] · P1**
- Steps: read `apps/desktop/src/Shell.tsx`.
- Expected: a 401 `ApiError` from `listThreads`/`createThread` calls `onLogout()` (bounces to
  Login); `threads` is never set to a non-array on error.

**G5 · Conversation streaming & banners · [CODE] · P1**
- Steps: read `apps/desktop/src/Conversation.tsx` + `useThreadStream.ts`.
- Expected: the WS reconnects with backoff on drop; a `!connected` state shows a
  "连接已断开" banner, a `connected && !hostOnline` state shows the yellow
  "本地运行环境未连接" banner; `send()` is guarded on `readyState === OPEN`
  (a message typed before the socket opens is not silently lost); `EventBlock` renders
  `text`/`tool-call`/`tool-result`/`error`.

### Area H — End-to-end manual acceptance (the SP-1 acceptance criteria — [MANUAL])

> Requires the full live setup (§2.2). Each maps to a user-observable outcome.

**H1 · Google login · [MANUAL] · P0** — Click "用 Google 登录" → system browser opens
Google consent → after consent the app leaves the Login screen and shows the shell.

**H2 · New chat · [MANUAL] · P0** — Click "+ New chat" → a thread is created and appears
under "Recents", and opens.

**H3 · Send → dispatch → Claude Code runs · [MANUAL] · P0** — Type a message + Enter →
the cloud log shows a `dispatch` to the host → `claude` runs in `~/.cogni/threads/<threadId>/`.

**H4 · Streaming response · [MANUAL] · P0** — The assistant's turn streams into the
conversation: text accrues under "Cogni:", tool calls show as 🔧 blocks; it settles into a
persisted assistant message.

**H5 · Neon persistence · [MANUAL] · P0** — Query Neon: rows exist in `threads`, `messages`,
and `events` for the conversation.

**H6 · Restart & resume · [MANUAL] · P0** — Quit and relaunch the app → the thread is still
in "Recents"; opening it shows the prior messages; sending again resumes (the cloud `dispatch`
carries the stored `runnerSessionId`).

**H7 · Host-offline empty state · [MANUAL] · P1** — Kill the runner-host daemon
(`kill $(cat ~/.cogni/daemon.pid)`) → the conversation shows the yellow
"本地运行环境未连接" banner.

### Area I — Negative, edge & robustness

**I1 · Malformed WS frame is ignored · [CODE] · P1** — In `host-ws.ts`, `client.ts`
(cloud) and `registry.ts` (runner-host): a non-JSON WS frame is caught by a try/catch and
ignored — it does not crash the process / cause an unhandled rejection.

**I2 · WS per-connection serialization · [CODE] · P2** — All three WS message handlers
process frames through a per-connection promise chain (so streamed events can't interleave).

**I3 · Host disconnect handling · [CODE] · P1** — `host-ws.ts` `onClose`: the host is
unregistered from `HostRouter`, marked `offline` in the DB, and the user's clients are told
`host-status: false`.

**I4 · Expired token → 401 · [CODE/MANUAL] · P0** — `/api/*` routes are behind a Bearer-JWT
middleware that returns 401 on a missing/invalid token; the WS endpoints close `4001` on a
bad token. (Code-verify the middleware; manually verify by tampering with the stored token.)

**I5 · `claude` binary missing · [MANUAL] · P2** — With `claude` not on PATH, send a
message → the runner-host adapter yields an `error` event (`claude_spawn_failed`) → a crimson
⚠ error block renders in the conversation rather than a hang/crash.

**I6 · drizzle-kit push is idempotent · [MANUAL] · P2** — Running
`pnpm --filter @cogni/cloud exec drizzle-kit push` twice does not error.

### Area J — Security

**J1 · Multi-tenant IDOR guard · [AUTO+CODE] · P0** — In `routes/client.ts`:
`GET /api/threads/:id`, `GET /api/threads/:id/events`, and the WS `subscribe`/`send` handlers
all gate on `threadBelongsToUser(db, threadId, userId)` — a thread you don't own returns
`404` (HTTP) or is silently dropped (WS). The guard helper itself is tested in C4.

**J2 · Open-redirect / token-exfiltration guard · [AUTO] · P0** — Covered by E4: the OAuth
`redirect` param can only be a `cogni://` URL, so the session token can't be redirected to
an attacker-controlled host.

**J3 · Host registration token strength · [AUTO] · P1** — Covered by C3: the registration
token is 64 hex chars = 256 bits of entropy.

**J4 · WS auth gating · [CODE] · P1** — `host-ws` requires a valid registration token (else
`close(4001)`); `/api/ws` requires a valid JWT in `?token=` (else `close(4001)`); the
`/api/ws` upgrade path is exempted from the Bearer HTTP middleware (a browser WS handshake
can't send an `Authorization` header) but still authenticates via the query token.

---

## 4. Test report template

> Fill this in after running/inspecting the cases above. Be concrete — cite exact
> output (test counts, error messages, file:line) as evidence.

### 4.1 Summary

| Area | P0 cases | Passed | Failed | Blocked | Not-run |
|---|---|---|---|---|---|
| A — Build & automated | | | | | |
| B — Contract | | | | | |
| C — Cloud data layer | | | | | |
| D — Cloud domain logic | | | | | |
| E — Cloud server / spine | | | | | |
| F — Runner-host | | | | | |
| G — Desktop app | | | | | |
| H — E2E manual acceptance | | | | | |
| I — Negative / edge | | | | | |
| J — Security | | | | | |
| **Total** | | | | | |

### 4.2 Environment used

- Repo state / commit: `___`
- Node / pnpm / Rust versions: `___`
- Which tiers were actually executed: `[AUTO] ___ · [CODE] ___ · [MANUAL] ___`
- If `[MANUAL]` not run, state why (no Neon / no Google creds / no GUI / no `claude` CLI).

### 4.3 Per-case results

| ID | Title | Tier | Status | Actual result / evidence |
|---|---|---|---|---|
| A1 | Dependencies install | | | |
| A2 | Library packages build | | | |
| ... | *(one row per case A1 … J4)* | | | |

### 4.4 Defects found

For each: **ID** · severity (Critical/Major/Minor) · area · description · repro steps ·
expected vs actual · suspected `file:line`. Distinguish real defects from the **known SP-1
stopgaps** listed in §1 (do not report those as defects).

### 4.5 Overall verdict

- Does the SP-1 walking skeleton hold up — are the four pillars (auth, data, runner
  abstraction, cloud↔desktop topology) all present and wired end-to-end?
- Is the automated suite green (84/84)? Is the headless spine test (E1) genuinely passing
  and non-flaky?
- Merge/ship readiness call: **Ready / Ready with fixes / Not ready** — with reasoning.
