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

## SP-2 batch 1 — DB helpers (2026-05-18 — 5 agent 并行)

**Pre-condition:** main at `e4b2ca8` (SP-2 schema deltas + extended
`RunnerSessionStatus` + test-db DDL synced). 5 tracks dispatched in one
parallel batch. Source spec: `docs/superpowers/specs/2026-05-18-cogni-sp2-accounts-sync-web-design.md`. Source plan: `docs/superpowers/plans/2026-05-18-cogni-sp2-accounts-sync-web.md` (36 tasks total; this batch covers T2-T6).

| Track | Commit | 内容 | 测试 |
|---|---|---|---|
| A · T2 sessions | `6517965` | `openRunnerSession` / `getCurrentActive` / `closeRunnerSession` / `getLatestSessionForThread` | 5 new (9 total in sessions.test.ts) |
| B · T3 auth-sessions | `99f5758` | New `auth-sessions.ts` — create / get / list / revoke / touch | 4 new |
| C · T4 hosts | `f991721` | `renameHost` / `softRemoveHost` / `isHostRemoved` / `getActiveHostsForUser` + `findHostByToken` filters removed | 3 new (4 total) |
| D · T5 find-or-link | `f409678` | New `auth/find-or-link.ts` — identity-then-email auto-merge | 4 new |
| E · T6 identities | `2c35154` | `countIdentities` + `deleteIdentity` | 2 new |

**Merge:** Five `git merge --no-ff` into main (`34beb04 902ae63 046de72 bed8fd3
3f437c3`). Plus follow-up `63dd3b8` for Track C's intentionally-skipped
boundary work (`routes/client.ts` switches `getUserHosts` → `getActiveHostsForUser`).

**Merged total:** +18 tests (66 → 84). `pnpm --filter @cogni/cloud typecheck`
clean. `pnpm -r build` green.

### Fanout effectiveness

- ~485 lines new (tests + impl)
- 5 agent total wallclock ≈ 12 min (slowest: Track A 11min; fastest: Track B 6.8min)
- Sequential estimate ≈ 50 min → saved ~38 min
- Integration gate time ≈ 5 min (diff/contract checks + batch merge + typecheck + boundary fix)
- Conflicts / rejections: 0 true conflicts; 1 boundary task left for integration lead (T4 step 4 by design)

### Lessons

1. **`git stash` is repo-wide; worktrees share the stash pool.** Track E's
   `git stash pop` in t6-identities accidentally popped Track A's wip. Track A
   later stepped on a similar situation. Both agents self-detected, re-stashed,
   continued. Final commits clean.
   **Future prompt fix:** add "avoid `git stash`; if you must,
   `git stash push -m '<track>:wip'` with a track-namespaced label so accidental
   pops are recoverable."
2. **Plan-vs-fixture-shape drift on `makeTestDb()`.** Plan code wrote
   `db = await makeTestDb()` and passed `db` straight to helpers, but
   `makeTestDb()` returns `{db, close}`. Three agents (B/D, plus A) each
   independently adapted to the destructured form per surrounding test files.
   **Future:** when planning, either grep the actual fixture shape, or upgrade
   the fixture to accept both call shapes.
3. **`test-db.ts` DDL must stay in sync with `schema.ts`.** T1 (foundation,
   solo) updated both, so the 5 downstream tracks' pglite tests all worked.
   If T1 had missed the DDL, every downstream track would fail on missing
   columns. **Future:** push the SP-2 known-issue "drizzle-kit migrations"
   forward.
4. **Main lock during fanout.** User pushed `0ad1e2c` (forward-port from
   sp1-followups) on main during the fanout window. The commit doesn't touch
   cloud, but: (a) it temporarily left unresolved conflict markers in
   `identities.ts` (since fixed); (b) my pending `routes/client.ts` working-tree
   edit got reset. **Future:** fanout windows = main is locked for unrelated
   merges, or unrelated merges go on a side branch.

### Sovereignty table

| Track | Independent path | Forbidden | Delivered |
|---|---|---|---|
| A | `packages/cloud/src/db/sessions.{ts,test.ts}` | schema, chat, client, contract | 5 new tests pass |
| B | `packages/cloud/src/db/auth-sessions.{ts,test.ts}` (new) | other db/ files | 4 new tests pass |
| C | `packages/cloud/src/db/hosts.{ts,test.ts}` | routes/client.ts (integration lead's job) | 3 new tests pass |
| D | `packages/cloud/src/auth/find-or-link.{ts,test.ts}` (new dir) | db/ writes | 4 new tests pass |
| E | `packages/cloud/src/db/identities.{ts,test.ts}` | other db/ files | 2 new tests pass |

### Branches now

- `main`: 6 new commits (5 merges + 1 boundary fix) on top of `e4b2ca8`
- All `track/t*-*` branches deleted (local; never pushed to origin)
- `.worktrees/t{2..6}-*/` removed

### Next candidates

- **Batch 2 (Section 7 HTTP routes):** T17 / T18 / T19 = `routes/identities.ts`
  + `routes/devices.ts` + `routes/hosts.ts`, three independent route files.
  Prerequisite: Sections 3-6 (auth + ClientHub fan-out + chat dispatcher) done
  serially first — too interdependent for parallel.
- **Batch 3 (UI extraction done):** `apps/web` scaffold + Settings hooks
  + SettingsPage, three agents on independent subdirs. Prerequisite:
  Section 8 (extract `@cogni/ui`) done — refactor with cross-file imports,
  can't safely parallelize.

---

## SP-2 batch 2 — isolated additions in Sections 2-6 (2026-05-18 — 5 agent 并行)

**Pre-condition:** main at `7b597b5`. Looked at plan Sections 2-6 (T7-T16) and
realized **5 of those tasks land in fully isolated files** even though the rest
of the section is interdependent — same trick batch 1 used. Dispatched these 5
in parallel before going serial on the dispatcher rework.

| Track | Commit | 内容 | 测试 |
|---|---|---|---|
| A · T11 host-router | `0f17053` | `Map<userId, Set<hostId>>` + `getOnlineHostsForUser` + `getHostByIdForUser`; **kept** `getHostForUser` for backward-compat | 3 new (7 total) |
| B · T8 device-name | `6884990` | New `auth/device-name.ts` — UA → "Chrome on macOS" label | 4 new |
| C · T9 env webUrl | `c2df28d` | `Env.webUrl: string` + `WEB_URL` env default `chat.ai-cognit.com` | 1 new |
| D · T13 ClientHub | `1dbfa8e` | 9 new methods (`subscribeList` / `unsubscribeThread` / `publishThreadMeta` / `publishThreadCreated` / `publishThreadDeleted` / `publishUserBroadcast` / `publishHostMeta` / `sendToConn` / `unsubscribeList`) + `listSubs` state | 4 new (8 total) |
| E · T7 protocol | `c01eb30` | `clientToCloudSchema` + 4 SP-2 variants; `cloudToClientSchema` + 9 SP-2 variants; SP-1 variants preserved | 15 new (35 total in contract) |

**Merge:** Five `git merge --no-ff` into main (`fee79af af98d58 dc27236 2b31b9b
c088c1e`). Plus follow-up `142bb5f` removing Track D's 4 temp
`as unknown as CloudToClient` casts now that Track E's protocol types exist.

**Merged total:** 84 → 145 (+61, of which ~12 cloud-helper net new, +15 contract
parse tests, +rebuilt cloud surface count). `pnpm -r build` green, both
typechecks clean, desktop bundle 269 KB JS.

### Fanout effectiveness

- ~395 lines new (tests + impl across 10 files)
- 5 agent total wallclock ≈ 7 min (slowest A 7.1min; fastest C 5.4min)
- Sequential estimate ≈ 35 min → saved ~28 min
- Integration gate time ≈ 4 min (diff/contract checks + 5 merges + cast cleanup + post-merge build/test/typecheck)
- Conflicts / rejections: 0 true conflicts. 0 boundary violations.
- 0 stash incidents (batch 1's lesson successfully baked into prompts)

### Lessons

1. **"Sections that look serial may have isolated tasks inside."** Plan
   Sections 2-6 are mostly serial because of dispatcher/chat interdependencies,
   but T7 / T8-device-name / T9-env / T11 / T13-methods are pure additions in
   their own files. Same pattern as batch 1 (which split DB Section 1 into 5
   parallel helpers). **Heuristic: scan the plan for "new file" tasks + "add
   method to isolated class" tasks; those parallelize even inside otherwise-serial
   sections.**
2. **Temp `as unknown as` cast for cross-track contract gap** worked.
   Track D needed a wire type that Track E was creating in parallel; rather
   than serialize, we let D use casts with explicit "Track E will provide"
   comments. Integration lead spent 2 min removing 4 cast lines post-merge.
   Pattern is reusable for any future "type producer + type consumer"
   parallel split.
3. **Batch 1 stash lesson stuck.** Adding "**don't use `git stash`**" to
   every prompt resulted in 0 stash incidents this batch. Per /fanout
   playbook: lessons go into the next batch's prompts immediately.
4. **3 agents independently noticed `server.e2e.test.ts` ECONNREFUSED flake
   when running full `pnpm vitest run packages/cloud` in parallel.** Each
   verified it disappeared on isolated re-run. This is a real port-reuse
   issue under concurrent worktrees — not new with this batch but worth
   filing for future work: either teach the e2e test to pick a random free
   port, or sequentialize via `vitest --pool=forks --poolOptions.forks.singleFork`.

### Sovereignty table

| Track | Independent path | Forbidden | Delivered |
|---|---|---|---|
| A | `packages/cloud/src/host-router.{ts,test.ts}` | chat.ts, host-ws.ts, contract | 3 new tests pass + `getHostForUser` retained |
| B | `packages/cloud/src/auth/device-name.{ts,test.ts}` (new) | other auth/, schema, routes | 4 new tests pass |
| C | `packages/cloud/src/env.{ts,test.ts}` | server.ts, main.ts, routes | 1 new test pass |
| D | `packages/cloud/src/client-hub.{ts,test.ts}` | routes/client.ts, contract | 4 new tests pass; 4 temp casts cleaned post-merge |
| E | `packages/contract/src/protocol.{ts,test.ts}` | cloud, desktop | 15 new tests pass |

### Branches now

- `main`: 7 new commits (5 merges + 1 cast cleanup + this log) on top of `7b597b5`
- All `track/sp2b2-*` branches deleted (local; not pushed to origin)
- `.worktrees/sp2b2-*/` removed

### Next candidates

- **Serial (me) next:** T8 routes callback refactor + T9 routes plumbing
  + T10 revoke check + T12 host-ws publishHostMeta + T13 routes wiring
  + T14-T16 chat dispatcher state machine — these all collide on
  `routes/client.ts` / `chat.ts` and need to flow as one author.
- **Batch 3 (after serial run lands T16):** T17 / T18 / T19 = settings
  routes (`/api/identities`, `/api/devices`, `/api/hosts` PATCH+DELETE),
  three independent route files. Ready to fan-out as soon as serial work
  ends.
- **Batch 4 (after Section 8 extract):** apps/web scaffold + settings hooks
  + SettingsPage UI, three agents on independent subdirs.

---
