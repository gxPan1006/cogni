# Integration log

Audit trail for /fanout batches in cogni. Each batch records what was parallelized, what merged, what broke, and what to remember next time.

---

## Email magic-link (C-phase) — 2026-05-16 (hybrid: 2-agent fanout inside a 5-phase serial spine)

**Goal**: add email magic-link login as an alternative to Google OAuth (solves GFW reachability for users in mainland China). Source spec: `docs/superpowers/specs/2026-05-16-email-magic-link-auth-design.md`. Source plan: `docs/superpowers/plans/2026-05-16-email-magic-link-auth.md` (15 tasks).

**Structure**: not pure fanout — the plan's first 4 tasks are a single contract layer (`findOrCreateUserByEmail` + `upsertIdentity`) that every later task depends on. So:

| Phase | Mode | Tasks | Commits |
|---|---|---|---|
| A | Serial (me) | Task 0-4: branch + DB schema + repos + 3 caller adapts | `802bb1c`, `fbc4c48` |
| B | **Fanout 2 agents** | Task 5-7: RateLimiter ⊥ EmailTransport+Resend | `7cc4bb3`, `ad6a9d1` (+ 2 merge commits) |
| C | Serial (me) | Task 8-10: env wiring + email routes | `7d535e0` |
| D | Serial (me) | Task 11-14: desktop api/Login/useAuth + docs | `d3bbb19` |
| E | Serial (me) | Task 15: full-suite verification + this log | (no code commit, this log + changelog only) |

**Fanout sub-step (Phase B)**:

| Track | Worktree | Commit | Content | Tests | Wallclock |
|---|---|---|---|---|---|
| B1 rate-limit | `../cogni-worktrees/rate-limit` | `7cc4bb3` | `rate-limit.ts` + test (sliding window, multi-bucket) | 4 pass | ~46s |
| B2 email-transport | `../cogni-worktrees/email-transport` | `ad6a9d1` | `email/transport.ts` + test (Fake/Console/Resend) | 4 pass | ~51s |

Both agents dispatched in a single message with `run_in_background: true`. Notifications arrived ~46s and ~51s in. No /poll, no SendMessage needed — both delivered clean on first try.

**Integration gate**: scope-scan + contract-scan both clean (each track touched only its sovereign files; nothing under `contract/`, `shared/`, `desktop/`, `db/`, `routes/`, `env.ts`, `server.ts`, `main.ts`). Batch-merged `--no-ff` into `email-magic-link`. Worktrees + remote branches cleaned up immediately after merge.

**Test count**: 84 (baseline on main) → 87 (post-A) → 95 (post-B) → 109 (post-C; D added no tests). +25 across DB / env / rate-limit / transport / send / callback.

**Typecheck**: clean throughout.
**Desktop build**: 20.71 KB CSS / 216 KB JS (post-D).

### Fanout effectiveness

- ~95 lines (B1) + ~143 lines (B2) ≈ 238 lines written in parallel
- Total agent wallclock: ~51s (max of the two, not sum) vs ~90-120s if serial
- Integration gate time: ~3 min (scope scan + 2 merges + post-merge tests + cleanup)
- Conflicts / rejections: **zero** — every agent's sovereignty held, contract was stable before dispatch.

### Lessons (delta vs sp1-followups fanout earlier this session)

**Worked again**: serial-then-fanout pattern. Phase A locked the contract (`findOrCreateUserByEmail` + `upsertIdentity` + new `email/` directory), then both B agents had genuinely independent sovereignty.

**Plan-as-prompt-content** — Pasting the full plan code-blocks straight into each agent's prompt removed any "what should I implement?" ambiguity. Agents reported "task complete" with the exact commit message structure the plan asked for. Zero back-and-forth needed.

**New: 2-track fanout below the skill's 3+ threshold**. The skill says "3 条以上 互相独立的子工作". User explicitly chose 2 tracks (B3 desktop-api was too thin, folded into Phase D). The 2-agent batch still beat serial by ~40-50% wallclock with no integration overhead — viable when each track is a genuinely-independent file pair.

**Caught a plan-vs-reality drift**: the plan's Task 3 "Step 6: pnpm typecheck — Expected FAIL" understated the blast radius. 6 setup-helper test files (`hosts.test.ts`, `threads.test.ts`, `sessions.test.ts`, `chat.test.ts`, `server.e2e.test.ts`, plus `users.test.ts` itself) all called `findOrCreateUser` and broke at runtime, not typecheck. Fixed inline by porting all of them in the same Phase A commit (`802bb1c`). Worth a one-line check in future plans: "after this rename, grep for `findOrCreate.*\{ oauthSub` and update all callers".

### Sovereignty table (B-phase)

| Track | Independent path | Forbidden | Delivered |
|---|---|---|---|
| B1 | `packages/cloud/src/rate-limit.{ts,test.ts}` | contract, shared, desktop, db/, routes/, env.ts, server.ts, main.ts, pnpm-lock.yaml | 4/4 tests pass |
| B2 | `packages/cloud/src/email/transport.{ts,test.ts}` | (same as B1) + rate-limit.ts | 4/4 tests pass |

### Branches now

- `main`: unchanged (last commit `d3a8a8a`)
- `email-magic-link`: this work, 8 commits ahead of main, ready for merge / PR
- All `track/*` branches deleted (local + remote)

### Next candidates

- SP-2 multi-node: in-process `pending` Map in `routes/email.ts` and in-process `RateLimiter` need a shared store (Redis or pg).
- Account-linking UI: today identities silently accumulate; SP-2 may want a user-visible identity list and a "remove identity" button.
- Email change flow: currently `users.email` is locked to first-write; SP-2 will need a verified-email-change ceremony if a user wants to switch primary.

---
