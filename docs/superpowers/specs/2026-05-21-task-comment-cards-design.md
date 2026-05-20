# Task Comment Cards + Kanban Drag-to-Requeue — Design

**Date:** 2026-05-21
**Status:** Draft (awaiting review)
**Area:** `packages/contract`, `packages/cloud`, `packages/runner-host`, `packages/ui`

## 1. Problem

A `ProjectTask` runs to a handoff point (`done` / `reviewing` / `needs-input`)
but leaves no narrative behind. The user opening the task drawer sees a state
stepper and metrics, but not *"what did the worker actually deliver, and what
should I check next?"* — and has no place to drop their own notes for the next
run.

We add a **comment feed** on the task's 主页面 (overview) tab: a card grid where

- the **worker** leaves a structured handoff note at each handoff (delivery
  summary / state-transition explanation / what the human should check next),
  and
- the **human** drops free-form supplementary notes.

Human comments are **purely informational** — posting one triggers nothing.
They become input to the worker only when the task is next picked up, which the
user does by **dragging the whole task card into the 排队中 (queued) column** on
the kanban (new interaction) or hitting the existing 再跑一次 / retry. At that
(re)dispatch the runner sees the accumulated human comments as part of its
initial context.

## 2. Non-goals

- No two-way "discussion that drives the runner mid-turn." Comments never
  forward to a live runner on their own.
- No change to the existing `needs-input` reply box or the Review
  批准/拒绝 buttons — they stay exactly as they are. Comments are an *additive*
  information layer, not a replacement for those lifecycle controls.
- No editing/threading/reactions on comments in this iteration (append-only
  feed; delete-own is allowed, see §5).
- The kanban allows free drag to **any** column (see §7); we do not lock it to
  a single re-queue target.

## 3. Data model

New table `task_comments` (drizzle, snake_case DB / camelCase contract):

| column | type | notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `task_id` | uuid → `project_tasks.id` `on delete cascade` | |
| `author` | text | `"worker"` \| `"user"` |
| `body` | text | markdown |
| `state` | text | task state at creation — drives the worker card's chip ("→ 完成") |
| `runner_session_id` | uuid → `runner_sessions.id` nullable | which run produced a worker note (audit) |
| `consumed_by_run_id` | uuid → `task_runs.id` nullable | **user comments only**: the run that ingested it; `null` = not yet delivered to a runner |
| `author_user_id` | uuid → `users.id` nullable | user comments only (who wrote it) |
| `created_at` | timestamptz default now | |

Index: `task_comments_task_created_idx` on `(task_id, created_at)`.

Contract (`packages/contract/src/project.ts`): `TaskComment` interface +
`taskCommentSchema`, plus `TASK_COMMENT_AUTHORS = ["worker","user"]`.

No new columns on `project_tasks`.

## 4. Worker handoff notes (explicit generation)

The worker **explicitly** writes its handoff note — we do not parse fragile
markers. Two coordinated pieces:

1. **Preamble instruction** (`orchestrator.ts` task preamble, near the existing
   "When done implementing, run `git add -A && git commit`" lines): instruct the
   runner that *its final assistant message before reporting completion or
   asking a question must be a structured handoff note* — three short parts:
   做了什么 / 交付物在哪 / 下一步人类该检查什么.

2. **Cloud capture at the transition.** A worker comment is snapshotted by the
   cloud at the moment the task hands off:
   - `done` / `reviewing`: in `ProjectDomain.handleRunnerDoneForTask`, after the
     transition, read the latest assistant message on the task's
     `executionThreadId` and insert it as a `worker` comment tagged with the new
     `state` and `runnerSessionId`.
   - `needs-input`: in `handleAskUserQuestion`, insert the `needsInputWhat` text
     as a `worker` comment tagged `state="needs-input"`. (This is the same
     string that still populates the existing reply card — duplicated into the
     feed for history.)

   Capture is best-effort: a failure to write the comment logs a warning and
   never blocks the lifecycle transition.

This needs **no new host→cloud protocol** — the cloud already ingests the
runner's messages into `events`/`messages` via `ChatDomain`.

## 5. Human comments (inert)

- **Create:** `POST /api/projects/:projectId/tasks/:taskId/comments` with
  `{ body }`. Inserts a `user` comment (`consumed_by_run_id = null`), broadcasts
  a `task-comment` event, returns the row. **No state transition, no runner
  contact.**
- **List:** `GET .../comments` returns the feed ordered by `created_at`.
- **Delete own:** `DELETE .../comments/:commentId` — a user may delete their own
  un-consumed comment (worker notes are immutable). Soft requirement; broadcast
  a `task-comment` deletion.

## 6. Injection at (re)dispatch

A shared helper `gatherUnconsumedUserComments(db, taskId)` returns user comments
with `consumed_by_run_id = null`, oldest-first. At every point where the cloud
(re)starts a runner turn for a task, we:

1. fetch those comments,
2. render them into the dispatched context as a clearly-labeled block
   (`## 人类补充说明\n- …`), appended after the task description in the dispatch
   preamble (queued→running) or to the forwarded turn (needs-input→running),
3. stamp `consumed_by_run_id` = the run that carried them.

Call sites:
- `orchestrator.dispatchQueuedTasks` — fresh `queued → running` dispatch.
- `ProjectDomain.replyToTask` — `needs-input → running` (comments ride alongside
  the user's direct reply).

If there are no unconsumed comments, behavior is unchanged.

## 7. Kanban free drag-and-drop (new interaction)

`ProjectBoard` `ColumnsView` currently renders static columns with no DnD. We
add HTML5 drag-and-drop (native `draggable`, no new dep). **Every card is
draggable to every column.** Dropping issues a single new mutation
`PATCH /api/projects/:projectId/tasks/:taskId/state { to }`; the cloud
(`ProjectDomain.moveTaskToState`) maps the target column to the corresponding
lifecycle action and runs any required side effects:

| Drop column | Effect |
| --- | --- |
| **排队中** (queued) | Re-queue. If a runner is live, detach/stop it first; route terminal states (`done`/`failed`/`cancelled`) through the existing retry path, active states (`running`/`needs-input`/`reviewing`) through cancel→queue. Orchestrator dispatches on the next tick and the run carries any unconsumed comments. |
| **进行中** (running) | Activate now. `queued → running` force-dispatch; `needs-input → running` resume; terminal states first re-queue then auto-run. |
| **Review** (reviewing) | Send to review. `running → reviewing` (stop runner, run merge gate). |
| **完成** (done) | Mark done. From `reviewing` = 批准并合并 (accept + merge per policy); from `running` = stop runner + mark done; otherwise a manual complete. |
| **等待输入** (needs-input) | Manual park. From `running` = pause awaiting input; from other states this is a manual state-label override (no fabricated runner activity). |

**Rules that hold across all drops:**
- Moving a card *out of* `running` always stops/detaches its runner first.
- Direct transitions in `LEGAL_TRANSITIONS` execute in one hop; re-activations
  from terminal states compose through the retry path so the card still lands in
  the requested column.
- A move with genuinely no coherent action is applied as a **manual state
  override** (persist the new `state`, stop any runner) rather than snapping
  back — the board is the user's to arrange. The orchestrator's defensive
  reconcile tolerates these (it never resurrects a user-set terminal state).
- A drop that is a no-op (same column) does nothing.

**Visible behavior:** while dragging, columns lift slightly and the hovered
column highlights; on drop the card animates into the target column and its
StatePill + stepper update immediately (optimistic), reconciling to the
server-confirmed state via the `task-event` stream. Hosts/worktree are sticky,
so a re-activated task resumes on the same branch.

## 8. UI — comment card grid (主页面)

In `TaskDetail` overview, below the `Actions` row (the red-box area in the
mock), render a `<TaskComments api taskId>` block:

- A `useTaskComments(api, taskId)` hook subscribes to the `task-comment` stream
  (initial REST fetch + WS deltas), mirroring `useTaskDetail`.
- **Layout:** a wrapping card grid (CSS grid, `auto-fill minmax(~200px)`),
  styled to match the existing `td-card` aesthetic (soft surface, rounded,
  subtle border), chronological.
  - **Worker card:** bot/sparkle icon, a state chip ("→ 完成" / "→ 待 Review" /
    "→ 等待输入") colored via the existing `STATE_COLOR`, markdown body, relative
    time.
  - **Human card:** user avatar/initial, markdown body, relative time, a small
    badge when `consumed_by_run_id != null` ("已交给 #2"), delete affordance on
    own un-consumed cards.
  - **Add card:** a trailing dashed "+" card. Click expands an inline mini
    `<Composer>`; submit appends a human card. Empty state (no comments) shows
    just the "+" card with hint text "给下一次运行留点说明…".

## 9. Components / boundaries

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `contract: TaskComment` | wire shape + zod | zod |
| `cloud/db/task-comments.ts` | CRUD + `gatherUnconsumed` + `markConsumed` | drizzle schema |
| `cloud/domains/project`: capture hooks | insert worker notes at transitions; inject user comments at dispatch | db/task-comments |
| `cloud/routes/projects.ts` | comment REST endpoints | db/task-comments, ClientHub |
| `protocol`: `task-comment` push | cloud→client delta | contract |
| `ui/hooks/useTaskComments` | live feed | ws-client |
| `ui/components/project/TaskComments` | the card grid | useTaskComments, Composer, Markdown |
| `cloud/domains/project`: `moveTaskToState` | map target column → lifecycle action + side effects | lifecycle, orchestrator/retry |
| `cloud/routes/projects.ts`: state PATCH | the `{ to }` endpoint | moveTaskToState |
| `ui ProjectBoard` DnD | drag task card → any column = state PATCH | state mutation |

## 10. Error handling

- Worker-note capture failure → warn + continue (never blocks lifecycle).
- Comment POST on a non-existent/cross-tenant task → 404, standard auth guard.
- Injection when runner offline → comments stay `consumed_by_run_id = null`
  (only stamped once a run actually starts), so a skipped/retried dispatch
  re-includes them next time.
- DnD drop on same column → client-side no-op, no request fired.
- `moveTaskToState` with a `StateMismatch` (card moved by another client mid-drag)
  → 409; UI re-syncs from the `task-event` stream and the optimistic move reverts.
- Stopping a live runner during a move uses the existing detach path; a failure
  there logs a warning and the state change still applies (runner reaped by
  reconcile).

## 11. Testing

- **contract:** `taskCommentSchema` round-trip.
- **cloud db:** insert/list/delete; `gatherUnconsumed` excludes consumed;
  `markConsumed` stamps run id (pglite).
- **cloud domain:** `handleRunnerDoneForTask` writes a worker card with the
  right `state`; `handleAskUserQuestion` writes a `needs-input` card;
  `replyToTask` + `dispatchQueuedTasks` inject unconsumed comments and stamp
  them; injection is idempotent across two dispatches (no double-inject).
- **cloud routes:** POST creates + broadcasts; DELETE guards ownership.
- **cloud domain (DnD):** `moveTaskToState` per target column — re-queue stops a
  live runner; `reviewing → done` accepts+merges; terminal → running composes
  through retry; out-of-running always detaches the runner; same-state is a
  no-op.
- **ui:** `useTaskComments` merges fetch + WS delta; `TaskComments` renders
  worker vs human cards; ProjectBoard drop on each column fires the state PATCH
  with the right target and optimistically moves the card.

## 12. Migration

`drizzle-kit push` adds `task_comments`. No backfill — existing tasks simply
start with an empty feed.
