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
