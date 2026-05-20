# Cogni

Cogni is a unified personal-assistant + AI-worker product — a merge of two
earlier demos (a toC general assistant and an AI-worker orchestrator) into one
professional product. The architecture: **the brain is in the cloud, the hands
are local** — a cloud control plane owns accounts, data, and orchestration,
while a desktop app registers a local **Runner Host** that actually runs agent
runners (Claude Code, and later others) on the user's machine.

This repository is **SP-1: the "spine"** — a walking skeleton that punches
through all four architectural pillars (accounts, data, the runner abstraction,
and the cloud↔desktop topology) with the minimum viable chat loop:

> desktop Google login → say something in chat → cloud routes to the local
> Runner Host → Claude Code runs → streaming text + tool events come back.

## Roadmap

SP-1 is the first of four subprojects, each going through spec → plan →
implementation:

- **SP-1 — Spine** (this repo): cloud control-plane skeleton + Neon + minimal
  auth; the Runner abstraction contract + Claude Code adapter; the Runner Host
  daemon + host protocol; a minimal desktop shell; the minimal chat-domain loop.
- **SP-2 — Accounts + multi-device sync + thin clients.**
- **SP-3 — Project domain** (supervised orchestrator, kanban, tracker
  integration, a second runner adapter).
- **SP-4 — Cross-domain layer + polish** (Recents/artifacts/memory, Windows).
  Explicitly out of scope: proactive intervention and cross-host task
  fan-out — deferred indefinitely, not part of SP-4.

Full design and rationale:
[`docs/superpowers/specs/2026-05-14-cogni-sp1-spine-design.md`](docs/superpowers/specs/2026-05-14-cogni-sp1-spine-design.md).

## Package layout

This is a pnpm monorepo:

- **`packages/contract`** — shared TypeScript types: the runner abstraction
  (capabilities, events, sessions) and the cloud↔host / cloud↔client protocol.
- **`packages/cloud`** — the cloud control plane: Neon/drizzle data layer,
  host-router, client-hub, the chat domain orchestrator, and a Hono server with
  Google OAuth, the host WebSocket, and the client WebSocket.
- **`packages/runner-host`** — the desktop-side daemon: host config, the Claude
  Code adapter, the runner manager, and the cloud registry client.
- **`apps/desktop`** — the Tauri 2 + React desktop app: OAuth deep-link login,
  the app shell + sidebar, the streaming conversation view, and daemon
  register/spawn.

(`packages/shared` holds small internal utilities, e.g. the logger.)

## Running it

See [`docs/RUNNING.md`](docs/RUNNING.md) for the full local run recipe —
prerequisites, Neon + Google OAuth setup, build steps, and the SP-1 acceptance
checklist.

## Tech stack

TypeScript end to end — Node + Hono on the cloud, Neon/drizzle for data,
Tauri 2 + React for the desktop app.
