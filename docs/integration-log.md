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

## SP-2 batch 3 — settings HTTP routes (2026-05-18 — 3 agent 并行)

**Pre-condition:** main at `ec0bb4c` (SP-2 cloud feature-complete except
settings routes). Plan Tasks 17-19 = three independent route files, each in
its own new file with its own test file. Perfectly fan-out-able.

| Track | Commit | 内容 | 测试 |
|---|---|---|---|
| F · T17 identities | `37fc02e` | `GET /api/identities` + `DELETE /api/identities/:kind/:sub` with last-one guard (409 + 404 no-info-leak) | 4 new |
| G · T18 devices | `5774001` | `GET /api/devices` (with `isCurrent` flag) + `DELETE /api/devices/:id` (publishes `device-list-changed`) | 3 new |
| H · T19 hosts | `5fc760a` | New routes/hosts.ts: GET (excludes removed) / POST / PATCH (rename + publish host-meta) / DELETE (soft-remove + unregister + publish host-meta + device-list-changed). Also deletes GET/POST handlers from routes/client.ts (intentional handoff). | 4 new |

**Merge:** Three `git merge --no-ff` into main (`9c6b262 77c8525 3d4f363`).
Plus integration commit `f1d2e41` registering the 3 new route modules in
server.ts (must come after `registerClientRoutes` — that's where the `/api/*`
Bearer + auth_session revocation middleware lives, and the new routes share it).

**Merged total:** 100 → 112 cloud tests (+12 = 4+3+4 new + 1 chat case I missed
counting), all green, NO ECONNREFUSED flake this run. Both typechecks clean.

### Fanout effectiveness

- ~776 lines new (tests + impl across 6 files; H also -16 from client.ts handoff)
- 3 agent total wallclock ≈ 3.5 min (slowest H 3.5min, fastest F 2.9min)
- Sequential estimate ≈ 14 min → saved ~10 min
- Integration gate time ≈ 3 min (diff scope check + 3 merges + server.ts wiring + post-merge full test/typecheck)
- Conflicts / rejections: 0. 0 boundary violations.
- 0 stash incidents.

### Lessons

1. **"intentional file handoff" worked.** Track H needed to delete 2
   handlers (`GET /api/hosts`, `POST /api/hosts`) from `routes/client.ts`
   as part of moving them into the new `routes/hosts.ts`. Granted H
   delete-only permission on those lines; H reported the deletions in its
   completion message; main worktree's client.ts diff shows clean -16
   lines, nothing else. Pattern works when scope is precisely "this file
   loses these specific handlers, period."
2. **All 3 agents added "用户表现+行为" sections to their reports.** Per
   CLAUDE.md "解读已有代码也要配上表现+行为" — the agents are picking up the
   habit. F explained the settings page interactions, G/H listed the live
   UI updates each endpoint triggers. Makes integration review faster
   because I don't have to imagine the UX, it's right there.
3. **One agent (G) flagged route registration order proactively.** Said in
   its completion message: "集成时 server.ts 需 registerDevicesRoutes 放在
   registerClientRoutes 之后(因 Bearer middleware 由 client.ts 挂在
   /api/*)". Saved me from registering in the wrong order and having
   auth-less endpoints. **Worth baking into future prompts:** "if your
   route depends on a middleware mounted elsewhere, flag the registration
   order in your completion report."

### Sovereignty table

| Track | Independent path | Forbidden | Delivered |
|---|---|---|---|
| F | `packages/cloud/src/routes/identities.{ts,test.ts}` (new) | server.ts, other routes/, contract | 4 tests pass |
| G | `packages/cloud/src/routes/devices.{ts,test.ts}` (new) | server.ts, other routes/, contract | 3 tests pass |
| H | `packages/cloud/src/routes/hosts.{ts,test.ts}` (new) + delete `GET/POST /api/hosts` from `routes/client.ts` | rest of client.ts, server.ts, contract | 4 tests pass; client.ts net -16 lines |

### Branches now

- `main`: 4 new commits (3 merges + 1 server.ts wiring) on top of `ec0bb4c`
- All `track/sp2b3-*` branches deleted (local; not pushed to origin)
- `.worktrees/sp2b3-*/` removed

### Next candidates

- **Serial (me) — Section 8 packages/ui extraction (T20-T24).** Tightly
  coupled refactor: move ~10 React component files from `apps/desktop/src/`
  into `packages/ui/src/`, update all import paths in `apps/desktop`,
  introduce ApiClient + useAuthCore split. Cross-file moves mean parallel
  agents would collide on every import update. One author.
  **Also intersects user's parallel UI work** — user's dirty Sidebar.tsx +
  Login.tsx in their working tree directly overlaps with what I'd move.
  Must coordinate with user before starting.
- **Batch 4 (after Section 8):** apps/web scaffold (T25) + Settings hooks
  (T28) + SettingsPage component (T29). Three independent subdirs once
  @cogni/ui is in place.

---

## SP-2 batch 4 — apps/web + settings hooks + multi-host UX (2026-05-18 — 3 agent 并行)

**Pre-condition:** main at `fe48c9e` (after Section 8 extraction — @cogni/ui
has ApiClient, useAuthCore, useThreadStream, all chat components). Three
genuinely independent territories.

| Track | Commit | 内容 |
|---|---|---|
| I · T25+T26+T27 apps/web | `c435a66` | Vite + React 19 + react-router 7 scaffold; api shim; useAuth-web (redirect-based, opposite of desktop's deep-link); GoogleAuthCallback / EmailAuthCallback; full route table (/login, /chat, /chat/:id, /settings, /auth/google/callback, /auth/email/callback); WebShell mirroring desktop layout; copied tokens.css + base.css for design parity |
| J · T28 settings hooks | `79bc8b3` | useDevices / useIdentities / useHosts — auto-refresh on mount, expose refresh() for after-mutation |
| L · T31+T32 multi-host UX + catchup | `adde8a2` | HostFallbackCard + NoHostBanner components; useThreadStream extended with `lastSeqRef` (catchup), `pendingFallback` / `pendingNoHost` state, `resolveFallback` / `dismissNoHost` actions; subscribe-thread + catchup-too-long handling |

**Merge:** Three `git merge --no-ff` (`2ca4586 87a604e ba3...`) + barrel
update `5f75959` exporting batch-4 additions.

**Integration drama:** User had 5 uncommitted UI files (Composer.tsx /
Conversation.tsx / Welcome.tsx / composer.css / conversation.css) dirty
during the fanout window. Track L's append to conversation.css collided.
Resolution: `git stash` the user's WIP → merge Track L → `git stash pop`
auto-merged cleanly (user's banner-removal + Track L's new fallback-card
styles ended up in different parts of the file). User's dirty changes
preserved end-to-end. **Lesson:** the "stash → merge → pop" recipe is the
right tool when fanout collides with user-in-flight WIP.

**Merged total:** cloud unchanged (no cloud surface in this batch);
@cogni/ui gained 5 new exports + extended hook surface; new apps/web
package added to monorepo. All builds + typechecks green (desktop, web,
cloud, ui, contract).

### Fanout effectiveness

- ~1118 lines new (apps/web 775 + settings hooks 118 + multi-host UX 225)
- 3 agent total wallclock ≈ 4 min (slowest I ~3.9min on apps/web; fastest J 1.4min)
- Sequential estimate ≈ 25 min → saved ~21 min
- Integration gate time ≈ 6 min (scope check + 3 merges + stash dance for
  Track L vs user's WIP + barrel update + full build/test)
- Conflicts / rejections: 0 true track conflicts; 1 user-WIP overlap
  resolved via stash pop. 0 boundary violations.

### Lessons

1. **Stash-pop dance for user-WIP collision works.** When the user is
   actively iterating on files that an agent also touches, the integration
   lead can: (a) stash user's WIP with a labeled message, (b) merge the
   agent's branch, (c) pop the stash and let git auto-merge. Git's 3-way
   merge handles append-only changes (Track L appending to bottom of
   conversation.css) cleanly even when the user rewrote unrelated
   sections higher in the file. Conflict markers only appear if both sides
   touch the same lines.
2. **Pre-creating downstream consumer with stub for not-yet-merged
   upstream worked.** Track I's WebShell referenced a `<SettingsStub>`
   placeholder for a SettingsPage that will only exist after Track J +
   integrator-rework lands. TODO comment with clear pointer ("swap this
   for `<SettingsPage api={api} onClose={...} />` after T29 lands")
   makes the integration step obvious. Same pattern as Track D's
   `as unknown as CloudToClient` casts in batch 2 — temp scaffolding
   with a clear sunset path.
3. **3 agents on truly independent territories ≈ 4-min wallclock.** This
   was the cleanest batch yet (no stash drama between agents — only the
   1 user-WIP collision at integration). The cost is in the prompt prep:
   each prompt was 80-130 lines because territories were heterogeneous
   (web vs hooks vs hook-plus-components). Worth it.

### Sovereignty table

| Track | Independent path | Forbidden | Delivered |
|---|---|---|---|
| I | `apps/web/**` (entire new dir) + .gitignore exception + pnpm-lock additive | packages/ui internals, desktop, contract | 16 files new, 775 LOC, web build green |
| J | `packages/ui/src/hooks/{useDevices,useIdentities,useHosts}.ts` (new) | barrel, ApiClient, anything else | 3 hooks, 118 LOC, typecheck green |
| L | `packages/ui/src/components/{HostFallbackCard,NoHostBanner}.tsx` (new) + conversation.css (append) + useThreadStream.ts (modify) | barrel, Conversation.tsx, contract, cloud | 4 files, 225 LOC, typecheck green |

### Branches now

- `main`: 5 new commits (3 merges + 1 barrel + this log) on top of `fe48c9e`
- All `track/sp2b4-*` branches deleted; `.worktrees/sp2b4-*/` removed
- User's 5 dirty UI files in main worktree preserved (Composer/Conv/Welcome + 2 css)

### Next candidates

- **Serial (me) — T29 SettingsPage extraction + wiring:** git mv user's
  apps/desktop/src/Settings.tsx into packages/ui/src/components/SettingsPage.tsx,
  wire its hardcoded MOCK_DEVICES/MOCK_HOSTS to the new useDevices/useHosts
  hooks (Track J), accept `api: ApiClient` prop, update Shell.tsx + apps/web
  App.tsx to import from @cogni/ui. Touches user's hand-crafted file — single
  author. Also: swap web's `<SettingsStub />` placeholder.
- **Serial (me) — Conversation.tsx wires up multi-host UX:** integrate
  HostFallbackCard + NoHostBanner into Conversation.tsx render tree using
  pendingFallback / pendingNoHost from extended useThreadStream. User has
  dirty Conversation.tsx so I'll fold this into a single commit after
  pulling their changes.
- **Serial (me) — Section 12 deploy ops:** nginx vhost for chat.ai-cognit.com,
  letsencrypt cert, register web's `/auth/google/callback` redirect URI in
  Google Cloud Console, first web rsync.
- **Final — Section 13 E2E:** run all 9 dogfood scenarios from spec §8.

---

## SP-2 followup batch — known-issues cleanup (2026-05-19 — 4 agent 并行)

**Pre-condition:** SP-2 main spec landed + deployed. Plan punted 4 things to
known-issues / future-work; this batch cleans them up before SP-3. All 4 land
in independent files, perfect fanout fit.

| Track | Commit | 内容 |
|---|---|---|
| A · /healthz | `7cac020` | `routes/health.ts` (new) — real DB ping via `db.execute(sql\`SELECT 1\`)`; 503 if DB fails; `/health` kept as alias for CF probe |
| B · e2e flake | `4dff6d3` | server.e2e.test.ts — root-cause fix: `serve()` sync return races with `listen()` bind; await listening callback + pin 127.0.0.1 to avoid IPv4/IPv6 dual-stack ECONNRESET smoke |
| C · CI Action | `1d0a719` | `.github/workflows/ci.yml` (new) — push/PR triggers build + typecheck + vitest; pnpm store cache; concurrency group; dependabot bonus |
| D · TokenStore | `ed67708` | `auth/token-store.ts` (new) — `TokenStore<T>` interface + `InMemoryTokenStore`; routes/email.ts swapped to use it; SP-2+1 Redis swap is 1-line in DI |

**Merge:** Four `git merge --no-ff` (`ca86d97 64713dd 385535e 0c86011`). One
stash-pop dance to resolve user's dirty `package.json` colliding with Track C's
new `"ci"` script — 3-way merge auto-resolved cleanly (both added to same JSON
section, no real conflict).

**Merged total:** 161 → 172 tests (+3 health + +8 token-store). 26 test files,
all green in 14s — Track B's flake fix means full-parallel runs are stable
now (vs the prior ~30-50% fail rate). All 7 build targets green (cloud +
contract + shared + runner-host + ui + desktop + web + apps/claude-watch).

### Fanout effectiveness

- ~560 lines new across 9 files
- 4 agent total wallclock ≈ 18-22 min (slowest B 18min — included 10 stress
  test runs; fastest A 18min — limited by 161-test suite re-runs)
- Sequential estimate ≈ 60 min → saved ~40 min
- Integration gate ≈ 5 min (stash-pop + 4 merges + full build/test/typecheck)
- 0 boundary violations. 1 user-WIP collision (handled by stash-pop, same
  recipe as batch 4).

### Lessons

1. **Root-cause > workaround for shared infrastructure.** Track C was scope-
   limited to CI config (couldn't touch test code), so it used
   `--no-file-parallelism` to dodge the e2e flake in CI. Track B was scope-
   licensed to fix the test and found the real cause: `@hono/node-server`'s
   `serve()` returns before `listen()` completes binding. Now both layers
   work right — CI can drop the `--no-file-parallelism` flag in a future
   followup since the test is no longer flaky.
2. **3 agents independently flagged the e2e flake.** A, C, D all noticed
   ECONNREFUSED during their own baseline runs (each ran `pnpm vitest run
   packages/cloud` to check non-regression). This triangulation gave Track
   B's fix high signal-to-noise. **Pattern: when an issue shows up
   independently in multiple agent reports, it's almost certainly real and
   worth fixing in its own track.**
3. **Interface-first abstraction for future-proofing pays off cheap.** Track
   D's `TokenStore<T>` interface + InMemoryTokenStore impl took ~5 min agent
   wallclock, ~80 LOC. SP-2+1 will be able to swap in a `RedisTokenStore`
   without touching `routes/email.ts` business logic. This is a 5-min-now /
   save-2-hours-later trade.

### Sovereignty table

| Track | Independent path | Forbidden | Delivered |
|---|---|---|---|
| A | `packages/cloud/src/routes/health.{ts,test.ts}` (new) + 5-line server.ts edit | other routes, db, contract | 3 tests pass |
| B | `packages/cloud/src/server.e2e.test.ts` (modify) | root vitest.config.ts, business code | 10/10 stable + 10/10 under 6-way CPU stress |
| C | `.github/workflows/ci.yml` + `dependabot.yml` (new) + package.json +1 line script | source code, tests | local CI three-way green |
| D | `packages/cloud/src/auth/token-store.{ts,test.ts}` (new) + `routes/email.ts` modify | routes/auth.ts, contract | 8 token-store tests + 10 email tests not-regressed |

### Branches now

- `main`: 5 new commits (4 merges + post-merge state) on top of `7e145a9`
- All `track/sp2-followup-*` branches deleted; `.worktrees/sp2-followup-*/` removed

### Next candidates

- ~~Apply TokenStore pattern to `routes/auth.ts` OAuth `pending` Map~~ —
  done in `2061cf1` (2026-05-19). 10-min TTL, lazy-evict-on-get + 5-min
  sweep, same pattern as `routes/email.ts`.
- ~~Drop `--no-file-parallelism` flag from CI~~ — done in `2061cf1`
  (2026-05-19). Validated locally with 5/5 parallel vitest runs all green
  (26/26 each) before pushing. Track B's listen-bind fix is doing its job.
- Wire a Redis-backed TokenStore impl + multi-node cogni-cloud (SP-2+1 work).
- Surface `/healthz` to whatever uptime monitor we eventually pick (CF
  Workers, Better Stack, etc.) and wire alerting.
- T36 dogfood scenarios 3/4/5/6/7 — need physical Mac (desktop offline
  queue, desktop reconnect catchup, two-desktop fan-out, web↔desktop
  fan-out, JWT revocation propagation). 1/2/8/9 already covered by
  DB-query + codex-handoff browser automation.

---

## SP-2 follow-up — multiplexed WS lifetime (2026-05-18, single-author)

**User-visible symptom:** every sidebar click flashed the red 胶囊 "与服务器的
连接已断开,正在重连…" and disabled the composer for a few hundred ms while a
fresh WebSocket handshake completed.

**Root cause:** `useThreadStream`'s `useEffect([api, threadId])` owned the
WebSocket itself — every `threadId` change ran the cleanup
(`ws.close()`) and re-entered `connect()`, even though the cloud's `/api/ws`
is per-user and supports many `subscribe-thread` subscriptions on one socket.
The SP-2 plan (line 27) had already prescribed a separate
`packages/ui/src/transport/ws-client.ts`, but batch 4 collapsed everything
into the hook. This follow-up actually lands `ws-client.ts`.

**Changes:**

| File | What |
|---|---|
| `packages/ui/src/transport/ws-client.ts` | new — `createWsClient(buildUrl)` returns long-lived multiplexed client; `subscribeThread()` returns an unsubscribe fn; per-thread frame routing + user-wide fan-out + onopen-driven resubscribe with latest `lastSeq`. |
| `packages/ui/src/transport/api.ts` | `ApiClient.wsClient` lazy singleton (one WS per ApiClient). |
| `packages/ui/src/hooks/useThreadStream.ts` | rewritten to consume `api.wsClient`. `connected` tracks the shared socket via `onConnectionChange`, no longer toggled by `threadId` change. |
| `packages/contract/src/protocol.ts` | additive: `host-fallback-prompt` / `no-host-online` now carry `threadId` so the multiplexed client can route them. |
| `packages/cloud/src/domains/chat.ts` | include `threadId` at the three emit sites. |
| `packages/contract/src/protocol.test.ts` | updated parse fixtures. |
| `packages/ui/src/transport/ws-client.test.ts` | new — 6 tests locking in the lifetime contract (switching subs ≠ reconnect, per-thread routing, user-wide fan-out, reconnect resubscribe with latest `lastSeq`, listener edges, `close()` stops reconnect loop). |
| `docs/superpowers/specs/2026-05-18-cogni-sp2-accounts-sync-web-design.md` | new §"客户端 WS 生命周期" makes the contract explicit (one WS per UI session; thread switch = frame, not reconnect). |

**User-visible behavior after:** clicking another chat in the sidebar leaves
the composer status pill alone (still green / unchanged). The red 重连中
胶囊 now only shows on a genuine socket drop.

**Tests:** 177 → 183 (+6 ws-client). All green, full sweep ~32s.

**Plan delta:** none — the plan already listed `ws-client.ts` as a new file;
this follow-up finally aligns code with plan.

---

## SP-3 项目域 + Codex adapter — 2026-05-19 (1+1+4 phased fanout, 6 agents)

**Goal**: 第一次新增业务域 —— 把 cogni 从对话助手扩到 "监督式 AI worker 编排器"。项目 + per-task git worktree + reconcile loop + 第二个 RunnerAdapter (Codex) + 权限模型简化。Source spec: `docs/superpowers/specs/2026-05-19-cogni-sp3-project-domain-design.md` (557 行 / 13 章)。Source plan: 无单独 plan 文件 —— 直接以 spec §12 的 5-track 拆分为扇出骨架。

**Structure**: not pure 5-way fanout —— Track A 定契约,B/C/D/E 全消费。于是:

| Phase | Mode | Tracks | Commits |
|---|---|---|---|
| Round 1 | **Solo** (1 agent) | A: contract + DB schema + db helpers + tests | `d6921e5` (merge `eca9b17`) |
| Mid-fix | Integration lead | 补 host RPC envelope (B BLOCKED 报告) | `12d0dca` |
| Round 2 | **Fanout 4 agents** | B: cloud domain / C: routes / D: runner-host + Codex / E: UI 接线 | `1e7b29c` / `af2b045` / `b07d0df` / `c89ba6b` (+ 4 merge commits) |
| Integration | lead | 解 server.ts/main.ts 冲突 + D envelope 适配 + C test fixup | `5c21867` |

**Round 1 (Track A solo)**:

| Track | Worktree | Commit | Content | Tests |
|---|---|---|---|---|
| A contract+db | `.worktrees/sp3-a-contract` | `d6921e5` | `contract/{project,host-protocol,protocol+,index+}.ts` + `cloud/db/{schema+,projects,test-db+}.ts` + 全套 test | 230 pass |

**Mid-fix**:Track B v1 BLOCKED 报告 contract 漏了 `host-rpc-request` / `host-rpc-response` 信封 union(只有 payload schema 没有 envelope)。Integration lead 加 commit `12d0dca`:`cloudToHostSchema` / `hostToCloudSchema` 各加一个 envelope variant + 4 round-trip test。B v2 拉新 main 重派。

**Round 2 (Fanout 4 agents)**:

| Track | Worktree | Commit | Content | Tests | Wallclock |
|---|---|---|---|---|---|
| B v2 cloud domain | `.worktrees/sp3-b-domain` | `1e7b29c` | `domains/project/` 全套(orchestrator + lifecycle + merge-gate + host-rpc) + `client-hub.ts` 追加 3 topic + `routes/host-ws.ts` 追加 sendHostRpc + in-flight RPC table | 302 pass | ~19min |
| C routes | `.worktrees/sp3-c-routes` | `af2b045` | `routes/projects.ts` (486 行) + `routes/projects.test.ts` (645 行, 29 test) + `routes/client.ts` 追加 6 subscribe-* + `server.ts` 追加 projectDomain field + `main.ts` 追加 registerProjectsRoutes | 171/171 cloud, 29 新 routes test | ~13min |
| D runner-host | `.worktrees/sp3-d-runner` | `b07d0df` | `git-ops.ts` (7 method + safety) + `fs-browse.ts` + `rpc-dispatcher.ts` + `adapters/codex/` 全套 + `main.ts/registry.ts` 追加 | 60/60 runner-host (16 base + 44 new), 296 full | ~13min |
| E UI | `.worktrees/sp3-e-ui` | `c89ba6b` | 6 组件提升到 `packages/ui/src/components/project/` + 3 个新 hook(useProjects/useProjectBoard/useTaskDetail) + `api.ts` 追加 15 method + `ws-client.ts` 扩 3 subscribe API + Shell/web 接线 + 删除 `apps/desktop/src/{NewProject,NewTask,Project,...}` (6 个 tsx + 6 个 css) | 25/25 ui, 275 full, desktop/web build green | ~24min |

**Integration gate (lead)**:
- B + C 都在 `server.ts` 加 `projectDomain` field(B 必填 / C 可选 + 本地 interface 定义)。冲突解:用 B 的 import-from-domain(单一真相),保留 C 的 `?:` optional(SP-1/SP-2 fixture 不强求传 projectDomain)。
- B + C 都改 `main.ts`(B 加 HostRpcClient + projectDomain.start;C 加 registerProjectsRoutes 调用)。冲突解:B 的实例化(带 hostRpc + start)+ C 的 routes mount 一起保留。
- C 的 routes/projects.ts 调用与 B 的 class 不完全对齐:`createProject` 多传 `initGit`(B 没该字段) → 删除;`replyToTask(taskId, content)` 改成 B 的对象签名 `{taskId,userId,content,sourceClientId}`(因为 B 内部复用 ChatDomain.handleClientSend 必须有 userId + sourceClientId)。test 配套改。
- D 的 wire 格式与 12d0dca envelope 不一致(D base 在 envelope 落地前):D 在 `registry.ts` 用 `hostRpcRequestSchema.safeParse` 直接 parse 裸 payload,fallback 才走 `cloudToHostSchema`。B 用信封发,D 不识别 → 静默 drop → 5min 超时。Integration fix:简化为只 parse envelope,`t === 'host-rpc-request'` 时 unwrap → dispatch → 回包 `host-rpc-response` 带 rpcId。

**merge 后全量**:`pnpm run ci` = build + typecheck + vitest **all green / 309 pass / 34 files / 0 fail / 0 skip**。

**扇出效果**:
- Round 1 (A solo):~12min wallclock,1567 行新增
- Round 2 (B/C/D/E 4 路并行):wallclock 取最长(E ~24min),累计 agent 总 wallclock ~69min,顺串成 1 人干约要 ~1.5 倍(因 B 重派 + 集成冲突解决)
- 4 个 round-2 commit 累计 ~7900 行新增 / ~990 行删除(主要是 E 把 desktop mock 组件搬到 packages/ui)
- Integration 介入时间:envelope mid-fix(~10min)+ 4 路 merge + 冲突解决 + D fixup + CI 验证(~20min)
- 冲突 / 驳回:1 次 BLOCKED(B v1 正确报 envelope gap;经 12d0dca 修复后 v2 顺利交付),0 次驳回

**踩坑 / 决策**:
- **契约 envelope 漏 union — Track A 漏的最关键事**。host-protocol.ts 定了 payload schema,但 protocol.ts 的 WS frame union 没把它们包进 envelope variant。B v1 第一时间检测到并报 BLOCKED(没硬扩 contract,严格遵循"越界必停")。整合期补一个 4-test commit 就行。**下次教训**:Track A 的 prompt 应该明确列出 "envelope union 的 variant 要加" 这一步,不要假定 agent 推断得出。
- **类 vs interface 双重定义**:C 在 server.ts 写本地 interface,B 把 class import 进来。整合时只能保留一个。**经验**:contract 这一层的"对象形状"应该写在 packages/contract/,不在 cloud 端再定一份。下次让 Track A 把 ProjectDomain class 用到的 input/output type(`CreateProjectInput` 等)也定到 contract.types/project.ts。
- **routes 的 reply call 签名分歧**:B 的 `replyToTask` 是 object 形参(需要 userId + sourceClientId 给 chat domain),C 写 routes 时不知道 B 会这么设计,默认了 `(taskId, content)` 两参。整合时由 C 的 routes 改 call site。**经验**:fanout 前明确域方法签名(写到 spec §一里的"interface")。
- **D 不知道 12d0dca**:D 派出时 12d0dca 还没合,D base 在 eca9b17。D 用了"先 try 裸 schema 再 fallback"的策略,逻辑自洽但和真实信封不兼容。**经验**:当 main 在 fanout 期间被 hotfix 推进,要不就把所有 in-flight worktree 全部 rebase + SendMessage 通知,要不就在 integration 期做适配。这次选了后者(因为 D 已经在跑,打扰成本更高)。
- **5-way 同派会翻车**:`/fanout` 自己的检查项"稳定契约"就是为 SP-3 这种"第一次新增业务域"准备的。若不把 A solo 跑,B/C/D/E 全要扩契约,合不回来。1+1+4 这种 phased fanout 是 fanout playbook 在"契约本轮要变"场景下的正确解法。
- **6 agent 总规模 vs 整合代价**:6 agent / ~10000 行净增 / 整合介入 ~30min。这是扇出 "7-9 agent 整合开始吃力" 区间的体感印证 —— 5-7 agent 是甜蜜点,再多就要拆两批。

**下一轮候选**:
- T36 dogfood 场景 3-7 (SP-2 留尾巴,需用户 Mac)
- SP-3+1:多节点 cogni-cloud (Redis-backed orchestrator leader 选举)、跨 host fan-out、per-task host override
- ProjectDomain 输入类型升到 contract 层
- 把 mock 数据从 `mock.ts` 完全清掉(SP-3 已删了 project 相关,但 chat/host 部分还在)
- Linear 集成(SP-3+1 单独 epic)
- 端到端真机演练:跑通 "新建项目 → 创建第一个 task → runner 启动 → reviewing → accept → merge to main" 完整链路


## SP-3 真机 dogfood + 部署 + follow-up — 2026-05-20

SP-3 扇出合 main 后,第一次把整条链路部署到生产 + 在真机(用户 Mac runner-host + prod cloud + Neon)端到端跑通"建项目 → 新任务 → runner 干活 → reviewing → Accept → merge"。**单测全绿 ≠ 真机能跑** —— 单测里所有 host RPC 都是 mock,真机暴露了 5 个集成 bug,全部修复并部署。

### 部署链路(全套)

| 层 | 操作 | 备注 |
|---|---|---|
| Cloud (`cloud.ai-cognit.com`) | prod-cognit 上 `git pull` + `pnpm build` + `systemctl restart cogni-cloud` | systemd service,跑 `node dist/main.js` |
| Neon DB | `drizzle-kit push`(用 .env 抠出的 DATABASE_URL,因为 .env 含 `<>` 无法 `source`) | 增量加 projects/project_tasks/task_runs + runner_sessions.task_id |
| Web (`chat.ai-cognit.com`) | `pnpm --filter web build` + `rsync apps/web/dist → /var/www/chat` + chown www-data | nginx 静态托管 |
| Runner-host | 用户 Mac 上 `pnpm build` + 写 `~/.cogni/host.json`(从 prod DB 直接造 host 记录拿 registrationToken)+ 起 daemon | 后改 launchd 持久化(见 #4) |

### 真机暴露的 5 个 bug(单测都没抓到)

| # | commit | bug | 为什么单测没抓到 |
|---|---|---|---|
| 1 | `6f703f3` | worktreePath 拼接漏斜杠 `${repoPath}.worktrees` | 我给 Track B 的 prompt 字符串就漏了斜杠,orchestrator.test.ts 的 fixture 也用同样错误形式 → 测试"绿"但跟真机一样错 |
| 2 | `203f58b` | createTask 没创 thread → orchestrator 永 skip dispatch | 单测的 fixture 手动 `updateTaskState(executionThreadId)` 预填了,绕过了 createTask 的真实路径 |
| 3 | `93bdddc` | gitWorktreeCreate 不幂等 | 单测不会模拟"WS 在 RPC ack 前断开 → cloud retry"这种时序 |
| 4 | `35e366c` | dispatch frame 没带 workspacePath → claude 跑在 `~/.cogni/threads/<id>` 而非 worktree | 单测只 assert dispatch frame 发出去了,没人验证 host 端 RunnerManager 真正用的 cwd |
| 5 | `96432e5` | reconcile 没有 running→reviewing 桥 → 完成的 task 卡 running | `handleRunnerDoneForTask` 有单测,但"谁调用它"没测;ChatDomain 不知 task,orchestrator reconcile 漏了这桥 |

**调试方法**:全靠两端 log 对照 —— `journalctl -u cogni-cloud -f`(cloud orchestrator tick 每 5s 报错)+ `~/.cogni/runner-host.log`(host RPC handler)。每个 bug 都是"cloud 报一个 HostRpcError 或卡某状态 → 看 host 实际执行 → 定位拼接/时序/字段问题"。

### Incident:`git add <whole-file>` 误带用户 WIP(prod build 挂 6 分钟)

做 follow-up #1B/#2 时,我 `git add packages/cloud/src/domains/chat.ts`。当时**工作树里 chat.ts 含用户正在做的 auto-title WIP**(引用了 `updateThreadTitle`/`getFirstTurnIfDefaultTitle`,这俩 helper 在 `threads.ts` WIP 里、还没 commit)。我的 `git add` 把整个 chat.ts(含 WIP 引用)stage 上去,但没带 threads.ts → push 后 prod 拉到的 main 上 chat.ts 引用了不存在的 export → `git reset --hard` 回滚 + 重 build 才恢复。期间还踩到 **tsbuildinfo 缓存导致 tsc 不 emit dist** 的坑(`find packages -name '*.tsbuildinfo' -delete` 才解)。用户在此期间自己把 auto-title WIP 补 commit 了(`f5d2496`),救了场。

**教训(已固化为习惯)**:
- [ ] commit 前永远 `git add <精确文件列表>`,不 `git add .` / 不 `git add <可能含 WIP 的文件>`
- [ ] commit 前永远 `git diff --cached --stat` 自检,确认暂存区 = 预期改动,没有意外文件
- [ ] 在用户有 WIP 的工作树里改文件,先 `git status` 看哪些文件本来就是 dirty;改这些文件时格外小心,只 stage 自己的 hunk(`git add -p`)
- [ ] prod 部署 build 失败时,先 `rm -rf dist + find -name '*.tsbuildinfo' -delete` 再重 build(增量缓存会骗你)
- [ ] drizzle-kit / node 读 prod .env 时,`.env` 含 `<>` 等特殊字符无法 `source` —— 用 `grep '^KEY=' .env | cut -d= -f2-` 抠单个值

### Follow-up(同日做完,来自 tbd.md)

| 项 | commit | 内容 |
|---|---|---|
| #1B | `f9b4577` | project.systemPrompt + FILE_COMMIT_RULES 前缀注入 dispatch message,让 claude 真写文件 + git commit(不再 plan-mode 贴代码) |
| #2 | `f9b4577` | AskUserQuestion tool-call → ChatDomain hook → ProjectDomain transition running→needs-input,卡片自动进"等待输入"列 |
| #6 | (DB) | soft-remove 用户 3 个废弃 "My Computer" host 行 |
| #3a | `2e0adaa` | merge/reject/cancel 后删 task branch —— 删除时机从 gitMergeToMain(worktree 还占用 branch → 必失败)移到 gitWorktreeRemove 之后(branch 已自由) |
| #4 | `3ffd88c` | runner-host launchd 持久化(KeepAlive 自拉 + RunAtLoad),真机验证 kill -9 后 5s 自动重启 |

### 仍 open(SP-3+1 候选)

- #3b 推到 remote(git push)开关 + ProjectSettings UI
- #5 改 mergePolicy 后立即 drain 队列(当前等下次 5s tick)
- AskUserQuestion 的多选项渲染(当前只取第一个 question text 进 needs_input_what)
- ProjectDomain 输入类型升到 contract 层(避免 cloud 端重复定义 interface,见 SP-3 扇出整合期 server.ts 双 interface 问题)

---

## SP-4 Workspace Chat 编排浮窗（2026-05-20 完成 — 3 agent 并行）

底部展开式对话浮窗:用户自然语言 → 在线宿主上的 orchestrator runner 经 cogni MCP 工具回调云端 REST → 项目/任务增删改 → 看板/列表实时刷新。Spec `docs/superpowers/specs/2026-05-20-workspace-chat-orchestrator-design.md`,Plan `docs/superpowers/plans/2026-05-20-workspace-chat-orchestrator.md`。

**契约先锁(integration lead 自做,派发前):** `d3ff0d0` — `PROJECT_EVENT_KINDS += "deleted"`、`StartSessionOpts += mcpConfigPath/allowedTools`、dispatch 帧 `+= orchestrator`。三条 track 只消费不改契约。

| Track | 主权 | 末 commit | 内容 | 测试 |
|---|---|---|---|---|
| cloud | `packages/cloud/**` | `3740aab` | deleteTask/Project + DELETE 路由 + Host-token 鉴权 + threads.kind + WorkspaceChatDomain + send 按 kind 路由 + thread-id 端点 | 265 pass（cloud 子集） |
| runner-host | `packages/runner-host/**` | `565968f` | @modelcontextprotocol/sdk + adapter `--mcp-config`/`--allowed-tools` + cogni-tools stdio MCP（工具→REST）+ `mcp-serve` 子命令 + orchestrator dispatch 注入 | 83 pass |
| ui | `packages/ui/**` + `apps/**` | `566e345` | Composer placeholder + applyProjectEvent deleted + WorkspaceChatBar 展开浮窗 + 两端挂载 | 41 pass |

**merge 后全量(`9af416c`)**:57 文件 / **481 tests 全绿**,`pnpm build` 类型检查通过。merge 三条均 0 冲突(主权目录互不相交)。

**扇出效果**:
- 累计 ~1660 行新增(cloud 890 / runner-host 461 / ui 311)。
- 3 agent wallclock:cloud ~10.7min、runner-host ~7min、ui ~4.8min(并行,墙钟约 11min)。
- Integration 介入:契约锁定 ~3min + 三条 gate scan + 批量 merge + lockfile/全量 ~5min。
- 冲突 / 驳回:**0**。三条 gate(scope/contract/lockfile)全过。

**踩坑 / 决策(三条 track 各自对齐仓库实际签名,非偷工)**:
- cloud:`CreateProjectInput.defaultHostId` 必填(计划测试片段省了);`send` 帧字段是 `text` 非 `content`;`workspaceChat` 设为 `ServerDeps` 可选(与 `projectDomain?` 一致,缺省回退普通 chat);`test-db.ts` 裸 SQL DDL 同步加 `kind` 列。
- runner-host:真实 `RunnerManager.dispatch(input, onEvent): Promise<void>`,非计划片段的 async-iterable;测试改用 onEvent 回调断言。
- ui:vitest 是 `environment:"node"` 无 jsdom/@testing-library —— WorkspaceChatBar 按计划降级为纯函数 `scopePlaceholder` 单测,浮窗交互留端到端手测。
- 设计第 4 条遵守:未改 host-ws,runner 事件流仍由 `ChatDomain.handleHostEvent` 统一处理,WorkspaceChatDomain 只做 send/dispatch。

**集成后待办(运行前必须)**:① 应用 Neon 迁移 `migrate-2026-05-20-thread-kind.ts`(幂等 `ADD COLUMN IF NOT EXISTS`);② 重启 cloud + runner-host daemon(用新 dist);③ 端到端手测(plan 收尾清单第 2-5 步)。

**下一轮候选**:per-task host override(SP-3+1);orchestrator 用 `--append-system-prompt` 替代首轮 preamble 前缀;project-level chat 优先用 `default_host_id` 选 host(当前与 chat 同走 onlineHosts[0])。
