# Task Comment Cards + Kanban Free Drag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a comment-card feed to a task's 主页面 (worker handoff notes + inert human comments injected into the runner only at next dispatch), and make the kanban allow dragging any task card to any column.

**Architecture:** New `task_comments` table + contract type + `task-comment` WS push. Worker notes are snapshotted cloud-side at each handoff transition (from the runner's last assistant message / the needs-input question). Human comments are inert; a `gatherUnconsumedUserComments` helper injects them into the dispatch/reply context and stamps `consumed_by_run_id`. Kanban DnD calls a new `moveTaskToState` domain method that maps each target column to a lifecycle action.

**Tech Stack:** TypeScript, zod (`@cogni/contract`), drizzle + pglite (cloud DB + tests), Hono routes, React 19 (`@cogni/ui`), vitest.

**Reference spec:** `docs/superpowers/specs/2026-05-21-task-comment-cards-design.md`

**Conventions reminder:** `noUncheckedIndexedAccess` + `verbatimModuleSyntax` are on — treat array/record lookups as `T | undefined` and use `import type` for type-only imports. `pnpm build` is required before `pnpm --filter @cogni/cloud dev`, but `pnpm test` (vitest) needs no build. Run a single test file with `pnpm vitest run <path>`.

---

## File Structure

| File | Create/Modify | Responsibility |
| --- | --- | --- |
| `packages/contract/src/project.ts` | Modify | `TaskComment` interface + `taskCommentSchema` + `TASK_COMMENT_AUTHORS` |
| `packages/contract/src/protocol.ts` | Modify | `task-comment` member in `cloudToClientSchema` |
| `packages/cloud/src/db/schema.ts` | Modify | `taskComments` drizzle table |
| `packages/cloud/src/db/test-db.ts` | Modify | `CREATE TABLE task_comments` for pglite tests |
| `packages/cloud/src/db/task-comments.ts` | Create | comment CRUD + `gatherUnconsumedUserComments` + `markCommentsConsumed` + `getLatestAssistantMessage` |
| `packages/cloud/src/db/task-comments.test.ts` | Create | db-layer tests |
| `packages/cloud/src/domains/project/comments.ts` | Create | domain helpers: `captureWorkerNote`, `renderCommentsForRunner` |
| `packages/cloud/src/domains/project/index.ts` | Modify | worker-note capture hooks, `addUserComment`, `deleteUserComment`, `moveTaskToState`, comment injection in `replyToTask`, `broadcastComment` |
| `packages/cloud/src/domains/project/orchestrator.ts` | Modify | preamble instruction + comment injection at dispatch |
| `packages/cloud/src/domains/project/comments.test.ts` | Create | domain capture/inject/move tests |
| `packages/cloud/src/routes/projects.ts` | Modify | comment endpoints + state PATCH |
| `packages/ui/src/transport/api.ts` | Modify | client methods |
| `packages/ui/src/transport/ws-client.ts` | Modify | route `task-comment` to task subscribers |
| `packages/ui/src/hooks/useTaskComments.ts` | Create | live comment feed hook |
| `packages/ui/src/components/project/TaskComments.tsx` | Create | card-grid UI |
| `packages/ui/src/components/project/task-detail.css` | Modify | comment card styles |
| `packages/ui/src/components/project/TaskDetail.tsx` | Modify | mount `<TaskComments>` in overview |
| `packages/ui/src/components/project/ProjectBoard.tsx` | Modify | drag-and-drop |

---

## Task 1: `TaskComment` contract type

**Files:**
- Modify: `packages/contract/src/project.ts` (add after the `TaskRun` schema block, before `// ─── Event-kind unions`)
- Test: `packages/contract/src/project.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/contract/src/project.test.ts`:

```ts
import { taskCommentSchema, TASK_COMMENT_AUTHORS } from "./project.js";

describe("taskCommentSchema", () => {
  it("round-trips a worker comment", () => {
    const c = {
      id: "c1", taskId: "t1", author: "worker" as const,
      body: "done: wrote snake.html", state: "done" as const,
      runnerSessionId: "rs1", consumedByRunId: null, authorUserId: null,
      createdAt: "2026-05-21T00:00:00.000Z",
    };
    expect(taskCommentSchema.parse(c)).toEqual(c);
  });

  it("rejects an unknown author", () => {
    expect(() => taskCommentSchema.parse({
      id: "c1", taskId: "t1", author: "robot", body: "x", state: "done",
      runnerSessionId: null, consumedByRunId: null, authorUserId: null,
      createdAt: "2026-05-21T00:00:00.000Z",
    })).toThrow();
  });

  it("exposes the author union", () => {
    expect(TASK_COMMENT_AUTHORS).toEqual(["worker", "user"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/contract/src/project.test.ts`
Expected: FAIL — `taskCommentSchema` / `TASK_COMMENT_AUTHORS` not exported.

- [ ] **Step 3: Implement the contract type**

In `packages/contract/src/project.ts`, after the `taskRunSchema` definition and before `// ─── Event-kind unions used by WS push payloads`:

```ts
// ─── TaskComment ──────────────────────────────────────────────────────────

/**
 * A card in a task's comment feed (主页面).
 *
 *  - `author: "worker"` — a handoff note the runner emitted at a transition.
 *    `state` is the task state it was tagged with ("done" / "reviewing" /
 *    "needs-input"); `runnerSessionId` links it to the run that produced it.
 *  - `author: "user"` — an inert supplementary note. It does NOT drive the
 *    runner on its own; it is injected into the runner's context only when the
 *    task is next (re)dispatched, at which point `consumedByRunId` is stamped
 *    with the `task_runs.id` that carried it. `authorUserId` records who wrote it.
 */
export const TASK_COMMENT_AUTHORS = ["worker", "user"] as const;
export type TaskCommentAuthor = (typeof TASK_COMMENT_AUTHORS)[number];
export const taskCommentAuthorSchema = z.enum(TASK_COMMENT_AUTHORS);

export interface TaskComment {
  id: string;
  taskId: string;
  author: TaskCommentAuthor;
  body: string;
  state: TaskState;
  runnerSessionId: string | null;
  consumedByRunId: string | null;
  authorUserId: string | null;
  createdAt: string;
}

export const taskCommentSchema: z.ZodType<TaskComment> = z.object({
  id: z.string(),
  taskId: z.string(),
  author: taskCommentAuthorSchema,
  body: z.string(),
  state: taskStateSchema,
  runnerSessionId: z.string().nullable(),
  consumedByRunId: z.string().nullable(),
  authorUserId: z.string().nullable(),
  createdAt: z.string(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/contract/src/project.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contract/src/project.ts packages/contract/src/project.test.ts
git commit -m "feat(contract): TaskComment type + schema"
```

---

## Task 2: `task-comment` WS frame

**Files:**
- Modify: `packages/contract/src/protocol.ts` (the `cloudToClientSchema` union, after the `task-event` member at ~line 253)
- Test: `packages/contract/src/protocol.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/contract/src/protocol.test.ts`:

```ts
import { cloudToClientSchema } from "./protocol.js";

it("parses a task-comment frame", () => {
  const frame = {
    t: "task-comment", kind: "created",
    comment: {
      id: "c1", taskId: "t1", author: "user", body: "ship it",
      state: "done", runnerSessionId: null, consumedByRunId: null,
      authorUserId: "u1", createdAt: "2026-05-21T00:00:00.000Z",
    },
  };
  const parsed = cloudToClientSchema.parse(frame);
  expect(parsed.t).toBe("task-comment");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/contract/src/protocol.test.ts`
Expected: FAIL — no `task-comment` variant.

- [ ] **Step 3: Add the frame**

In `packages/contract/src/protocol.ts`, ensure `taskCommentSchema` is imported with the other project imports at the top of the file (find the existing `projectSchema, projectTaskSchema, ... taskEventKindSchema` import and add `taskCommentSchema`). Then add this member to the `cloudToClientSchema` `z.discriminatedUnion("t", [ ... ])` right after the `task-event` object:

```ts
  // SP-3 task comment feed (主页面). Routed to per-task subscribers only —
  // the board does not render comments. `kind: "deleted"` carries the row
  // whose `id` was removed.
  z.object({
    t: z.literal("task-comment"),
    kind: z.enum(["created", "deleted"]),
    comment: taskCommentSchema,
  }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/contract/src/protocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contract/src/protocol.ts packages/contract/src/protocol.test.ts
git commit -m "feat(contract): task-comment WS frame"
```

---

## Task 3: `task_comments` table

**Files:**
- Modify: `packages/cloud/src/db/schema.ts` (after the `taskRuns` table, ~line 228)
- Modify: `packages/cloud/src/db/test-db.ts` (add `CREATE TABLE` so pglite tests have it)

- [ ] **Step 1: Add the drizzle table**

In `packages/cloud/src/db/schema.ts`, after the `taskRuns` table definition:

```ts
/**
 * One card in a task's comment feed. `author='worker'` rows are handoff notes
 * captured at a transition; `author='user'` rows are inert human notes that
 * are injected into the runner context only when a later run consumes them
 * (`consumed_by_run_id` stamped at that point).
 */
export const taskComments = pgTable("task_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id").notNull().references(() => projectTasks.id, { onDelete: "cascade" }),
  author: text("author").notNull(),
  body: text("body").notNull(),
  state: text("state").notNull(),
  runnerSessionId: uuid("runner_session_id").references(() => runnerSessions.id),
  consumedByRunId: uuid("consumed_by_run_id").references(() => taskRuns.id),
  authorUserId: uuid("author_user_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  byTaskCreated: index("task_comments_task_created_idx").on(t.taskId, t.createdAt),
}));
```

Verify `users` and `runnerSessions` are already imported/declared in this file (they are — `runnerSessions` is referenced by `taskRuns` above and `users` by other tables). No new imports needed beyond what's already present (`pgTable`, `uuid`, `text`, `timestamp`, `index`).

- [ ] **Step 2: Add the pglite DDL**

In `packages/cloud/src/db/test-db.ts`, find the block of `CREATE TABLE` statements (the `messages` table is at the documented line ~35). After the `task_runs` CREATE TABLE statement, add:

```sql
CREATE TABLE task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references project_tasks(id) on delete cascade,
  author text not null,
  body text not null,
  state text not null,
  runner_session_id uuid references runner_sessions(id),
  consumed_by_run_id uuid references task_runs(id),
  author_user_id uuid references users(id),
  created_at timestamp not null default now()
);
```

(Match the surrounding string-literal style in `test-db.ts` — if the DDL is one big template string, append this statement inside it; if statements are separate, add a new one.)

- [ ] **Step 3: Verify the schema compiles**

Run: `pnpm --filter @cogni/cloud exec tsc --noEmit -p tsconfig.json` (or `pnpm typecheck`)
Expected: no errors referencing `taskComments`.

- [ ] **Step 4: Commit**

```bash
git add packages/cloud/src/db/schema.ts packages/cloud/src/db/test-db.ts
git commit -m "feat(cloud): task_comments table + pglite DDL"
```

> **Migration note:** after merge, apply to Neon with `pnpm --filter @cogni/cloud exec drizzle-kit push`. No backfill — existing tasks start with an empty feed.

---

## Task 4: DB layer for comments

**Files:**
- Create: `packages/cloud/src/db/task-comments.ts`
- Test: `packages/cloud/src/db/task-comments.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cloud/src/db/task-comments.test.ts`. Use the existing pglite harness pattern — copy the `makeTestDb` / seed import style from `packages/cloud/src/db/projects.test.ts` (open that file first to mirror exactly how it creates a db, a user, a project, and a task). The test body:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./test-db.js"; // mirror projects.test.ts's actual import
import {
  insertComment, listComments, deleteComment,
  gatherUnconsumedUserComments, markCommentsConsumed, getLatestAssistantMessage,
} from "./task-comments.js";
// plus the helpers projects.test.ts uses to seed a user/project/task/run/thread

describe("task-comments db", () => {
  let db: Awaited<ReturnType<typeof makeTestDb>>;
  let taskId: string;
  beforeEach(async () => {
    db = await makeTestDb();
    // seed user + project + task exactly as projects.test.ts does; capture taskId
  });

  it("insert + list returns chronological feed", async () => {
    await insertComment(db, { taskId, author: "user", body: "first", state: "done", authorUserId: null });
    await insertComment(db, { taskId, author: "worker", body: "note", state: "done", runnerSessionId: null });
    const list = await listComments(db, taskId);
    expect(list.map((c) => c.body)).toEqual(["first", "note"]);
    expect(list[0]!.author).toBe("user");
  });

  it("gatherUnconsumed returns only unconsumed user comments oldest-first", async () => {
    await insertComment(db, { taskId, author: "user", body: "u1", state: "done", authorUserId: null });
    await insertComment(db, { taskId, author: "worker", body: "w1", state: "done", runnerSessionId: null });
    const got = await gatherUnconsumedUserComments(db, taskId);
    expect(got.map((c) => c.body)).toEqual(["u1"]);
  });

  it("markCommentsConsumed stamps the run id and excludes them next time", async () => {
    const c = await insertComment(db, { taskId, author: "user", body: "u1", state: "done", authorUserId: null });
    // create a task_run row first (mirror projects.test.ts createTaskRun usage) → runId
    await markCommentsConsumed(db, [c.id], runId);
    expect(await gatherUnconsumedUserComments(db, taskId)).toEqual([]);
  });

  it("deleteComment removes the row", async () => {
    const c = await insertComment(db, { taskId, author: "user", body: "x", state: "done", authorUserId: null });
    await deleteComment(db, c.id);
    expect(await listComments(db, taskId)).toEqual([]);
  });
});
```

> The seed boilerplate (`runId`, user/project/task) must be filled from `projects.test.ts`'s real helpers. Read that file before writing this test.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cloud/src/db/task-comments.test.ts`
Expected: FAIL — `./task-comments.js` does not exist.

- [ ] **Step 3: Implement the db layer**

Create `packages/cloud/src/db/task-comments.ts`:

```ts
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { taskComments, messages } from "./schema.js";
import type { AnyDb } from "./users.js";
import type { TaskComment } from "@cogni/contract";

type Row = typeof taskComments.$inferSelect;

function toComment(r: Row): TaskComment {
  return {
    id: r.id,
    taskId: r.taskId,
    author: r.author as TaskComment["author"],
    body: r.body,
    state: r.state as TaskComment["state"],
    runnerSessionId: r.runnerSessionId,
    consumedByRunId: r.consumedByRunId,
    authorUserId: r.authorUserId,
    createdAt: r.createdAt.toISOString(),
  };
}

export interface InsertCommentInput {
  taskId: string;
  author: "worker" | "user";
  body: string;
  state: TaskComment["state"];
  runnerSessionId?: string | null;
  authorUserId?: string | null;
}

export async function insertComment(db: AnyDb, input: InsertCommentInput): Promise<TaskComment> {
  const rows = await db.insert(taskComments).values({
    taskId: input.taskId,
    author: input.author,
    body: input.body,
    state: input.state,
    runnerSessionId: input.runnerSessionId ?? null,
    authorUserId: input.authorUserId ?? null,
  }).returning();
  return toComment(rows[0]!);
}

export async function listComments(db: AnyDb, taskId: string): Promise<TaskComment[]> {
  const rows = await db.select().from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    .orderBy(asc(taskComments.createdAt));
  return rows.map(toComment);
}

export async function getComment(db: AnyDb, commentId: string): Promise<TaskComment | null> {
  const rows = await db.select().from(taskComments).where(eq(taskComments.id, commentId)).limit(1);
  return rows[0] ? toComment(rows[0]) : null;
}

export async function deleteComment(db: AnyDb, commentId: string): Promise<void> {
  await db.delete(taskComments).where(eq(taskComments.id, commentId));
}

/** Unconsumed `user` comments for a task, oldest-first. */
export async function gatherUnconsumedUserComments(db: AnyDb, taskId: string): Promise<TaskComment[]> {
  const rows = await db.select().from(taskComments)
    .where(and(
      eq(taskComments.taskId, taskId),
      eq(taskComments.author, "user"),
      isNull(taskComments.consumedByRunId),
    ))
    .orderBy(asc(taskComments.createdAt));
  return rows.map(toComment);
}

export async function markCommentsConsumed(db: AnyDb, commentIds: string[], runId: string): Promise<void> {
  if (commentIds.length === 0) return;
  await db.update(taskComments)
    .set({ consumedByRunId: runId })
    .where(inArray(taskComments.id, commentIds));
}

/** Latest assistant message text on a thread, or null. Used to snapshot a worker handoff note. */
export async function getLatestAssistantMessage(db: AnyDb, threadId: string): Promise<string | null> {
  const rows = await db.select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.role, "assistant")))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return rows[0]?.content ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cloud/src/db/task-comments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/db/task-comments.ts packages/cloud/src/db/task-comments.test.ts
git commit -m "feat(cloud): task_comments db layer"
```

---

## Task 5: Domain helpers — capture + render

**Files:**
- Create: `packages/cloud/src/domains/project/comments.ts`
- Test: `packages/cloud/src/domains/project/comments.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cloud/src/domains/project/comments.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderCommentsForRunner } from "./comments.js";
import type { TaskComment } from "@cogni/contract";

const mk = (body: string): TaskComment => ({
  id: "c", taskId: "t", author: "user", body, state: "queued",
  runnerSessionId: null, consumedByRunId: null, authorUserId: "u",
  createdAt: "2026-05-21T00:00:00.000Z",
});

describe("renderCommentsForRunner", () => {
  it("returns null for no comments", () => {
    expect(renderCommentsForRunner([])).toBeNull();
  });
  it("renders a labeled bullet list", () => {
    const out = renderCommentsForRunner([mk("改成深色主题"), mk("加音效")]);
    expect(out).toContain("# 人类补充说明");
    expect(out).toContain("- 改成深色主题");
    expect(out).toContain("- 加音效");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cloud/src/domains/project/comments.test.ts`
Expected: FAIL — `./comments.js` not found.

- [ ] **Step 3: Implement**

Create `packages/cloud/src/domains/project/comments.ts`:

```ts
import type { AnyDb } from "../../db/users.js";
import type { TaskComment, TaskState } from "@cogni/contract";
import { insertComment, getLatestAssistantMessage } from "../../db/task-comments.js";

export interface CommentLogger {
  warn?: (obj: unknown, msg?: string) => void;
}

/**
 * Snapshot the runner's handoff note as a `worker` comment at a transition.
 * Best-effort: a failure logs and returns null — it must never block a
 * lifecycle transition. `body` may be passed directly (e.g. the needs-input
 * question text); otherwise we read the thread's latest assistant message.
 */
export async function captureWorkerNote(
  db: AnyDb,
  args: {
    taskId: string;
    state: TaskState;
    threadId?: string | null;
    body?: string | null;
    runnerSessionId?: string | null;
  },
  logger?: CommentLogger,
): Promise<TaskComment | null> {
  try {
    let body = args.body?.trim() ?? "";
    if (!body && args.threadId) {
      body = (await getLatestAssistantMessage(db, args.threadId))?.trim() ?? "";
    }
    if (!body) return null;
    return await insertComment(db, {
      taskId: args.taskId,
      author: "worker",
      body,
      state: args.state,
      runnerSessionId: args.runnerSessionId ?? null,
    });
  } catch (err) {
    logger?.warn?.({ taskId: args.taskId, err: String(err) }, "captureWorkerNote failed");
    return null;
  }
}

/** Render unconsumed user comments into a runner-context block, or null if none. */
export function renderCommentsForRunner(comments: TaskComment[]): string | null {
  if (comments.length === 0) return null;
  const lines = ["# 人类补充说明", "(以下是人类在上一次运行后追加的说明,请一并考虑)", ""];
  for (const c of comments) lines.push(`- ${c.body.trim()}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cloud/src/domains/project/comments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/domains/project/comments.ts packages/cloud/src/domains/project/comments.test.ts
git commit -m "feat(cloud): worker-note capture + comment render helpers"
```

---

## Task 6: Capture worker note at needs-input + done/reviewing

**Files:**
- Modify: `packages/cloud/src/domains/project/index.ts` (`handleAskUserQuestion` ~line 504, `handleRunnerDoneForTask` ~line 524)
- Test: `packages/cloud/src/domains/project/comments.test.ts` (extend) or the existing `ask-user-input.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/cloud/src/domains/project/comments.test.ts` a domain-level test. Mirror the harness in `packages/cloud/src/domains/project/ask-user-input.test.ts` (read it for how it constructs a `ProjectDomain` with a pglite db + fake `clients`/`hostRpc`). Assertions:

```ts
// after handleAskUserQuestion(threadId, "需要确认配色?")
const comments = await listComments(db, taskId);
expect(comments.some((c) => c.author === "worker" && c.state === "needs-input"
  && c.body.includes("需要确认配色"))).toBe(true);

// after handleRunnerDoneForTask(taskId) with an assistant message seeded on the thread
const after = await listComments(db, taskId);
expect(after.some((c) => c.author === "worker"
  && (c.state === "done" || c.state === "reviewing"))).toBe(true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cloud/src/domains/project/comments.test.ts`
Expected: FAIL — no worker comment is written yet.

- [ ] **Step 3: Wire capture into the two handlers**

In `packages/cloud/src/domains/project/index.ts`, add the import near the other `./` imports:

```ts
import { captureWorkerNote } from "./comments.js";
```

In `handleAskUserQuestion`, after `this.broadcastTask(updated, "state-changed");` (inside the `try`), add:

```ts
      const note = await captureWorkerNote(
        this.deps.db,
        { taskId: task.id, state: "needs-input", body: trimmed },
        this.deps.logger,
      );
      if (note) this.broadcastComment(note, "created");
```

In `handleRunnerDoneForTask`, after the successful `transitionTask` + `this.broadcastTask(updated, "state-changed");`, add:

```ts
      const note = await captureWorkerNote(
        this.deps.db,
        {
          taskId,
          state: next, // "done" | "reviewing" from the merge gate
          threadId: task.executionThreadId,
        },
        this.deps.logger,
      );
      if (note) this.broadcastComment(note, "created");
```

(`broadcastComment` is added in Task 9. If implementing strictly in order, temporarily inline `this.deps.clients.broadcastTask(note.taskId, { t: "task-comment", kind: "created", comment: note })` and replace with `broadcastComment` in Task 9.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cloud/src/domains/project/comments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/domains/project/index.ts packages/cloud/src/domains/project/comments.test.ts
git commit -m "feat(cloud): capture worker handoff notes at transitions"
```

---

## Task 7: Inject comments at orchestrator dispatch

**Files:**
- Modify: `packages/cloud/src/domains/project/orchestrator.ts` (`tryDispatchTask`, the `messageParts` block ~line 425 and the `createTaskRun` block ~line 475)
- Test: `packages/cloud/src/domains/project/orchestrator.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

In `packages/cloud/src/domains/project/orchestrator.test.ts`, add a test that mirrors the existing dispatch test setup (it already constructs a project + queued task + fake host conn that records sent frames). After inserting an unconsumed user comment on the task and running one `tick()`:

```ts
import { insertComment, gatherUnconsumedUserComments } from "../../db/task-comments.js";
// ...
await insertComment(db, { taskId, author: "user", body: "用深色主题", state: "queued", authorUserId: userId });
await orch.tick();
// the captured dispatch frame's message contains the injected block:
expect(sentFrames.at(-1)!.message).toContain("# 人类补充说明");
expect(sentFrames.at(-1)!.message).toContain("用深色主题");
// and the comment is now consumed:
expect(await gatherUnconsumedUserComments(db, taskId)).toEqual([]);
```

(Use the same `sentFrames` capture the existing dispatch test uses; read the file to match its fake-conn shape.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cloud/src/domains/project/orchestrator.test.ts`
Expected: FAIL — message has no `人类补充说明` block; comment stays unconsumed.

- [ ] **Step 3: Implement injection**

In `orchestrator.ts`, add imports:

```ts
import { gatherUnconsumedUserComments, markCommentsConsumed } from "../../db/task-comments.js";
import { renderCommentsForRunner } from "./comments.js";
```

In `tryDispatchTask`, gather comments **before** building `messageParts` (just after `const adapter = ...` or right before the `messageParts` array). Insert into the message after the task title/description:

```ts
      const unconsumed = await gatherUnconsumedUserComments(this.deps.db, task.id);
      const commentBlock = renderCommentsForRunner(unconsumed);
      if (commentBlock) {
        messageParts.push("", commentBlock);
      }
```

(Add this right after the `if (task.description) { messageParts.push("", task.description); }` line, before `const frame: CloudToHost = {`.)

Then, after the `createTaskRun({...})` call succeeds (it returns the run — capture it), stamp the comments. Change:

```ts
    await createTaskRun(this.deps.db, {
```
to capture the return and mark consumed:
```ts
    const run = await createTaskRun(this.deps.db, {
      taskId: task.id,
      runnerSessionId: session.id,
      attemptNumber: priorRuns.length + 1,
      startedAt: updated.startedAt ? new Date(updated.startedAt) : new Date(),
    });
    if (unconsumed.length > 0) {
      await markCommentsConsumed(this.deps.db, unconsumed.map((c) => c.id), run.id);
    }
```

> `unconsumed` is declared inside the `try` that builds the frame. Move its declaration to function scope (declare `let unconsumed: TaskComment[] = []` near the top of `tryDispatchTask` and assign inside the try) so it's visible at the `createTaskRun` site. Add `import type { TaskComment } from "@cogni/contract";` if not present.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cloud/src/domains/project/orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/domains/project/orchestrator.ts packages/cloud/src/domains/project/orchestrator.test.ts
git commit -m "feat(cloud): inject unconsumed comments into dispatch context"
```

---

## Task 8: Inject comments at replyToTask

**Files:**
- Modify: `packages/cloud/src/domains/project/index.ts` (`replyToTask` ~line 215)
- Test: `packages/cloud/src/domains/project/comments.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `comments.test.ts`: with a `needs-input` task that has an unconsumed user comment, calling `replyToTask` should fold the comment into the content forwarded to `chat.handleClientSend`. Mock/spy on `chat.handleClientSend` (the harness already injects a fake `chat`) and assert the `content` it receives contains both the reply text and the comment block, and that the comment becomes consumed.

```ts
await insertComment(db, { taskId, author: "user", body: "顺便加深色", state: "needs-input", authorUserId: userId });
await domain.replyToTask({ taskId, userId, content: "好的继续", sourceClientId: "test" });
expect(sentSends.at(-1)!.content).toContain("好的继续");
expect(sentSends.at(-1)!.content).toContain("顺便加深色");
expect(await gatherUnconsumedUserComments(db, taskId)).toEqual([]);
```

(`sentSends` = the fake `chat.handleClientSend` call recorder; match the existing harness.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cloud/src/domains/project/comments.test.ts`
Expected: FAIL — content lacks the comment; comment unconsumed.

- [ ] **Step 3: Implement**

In `replyToTask`, after the `transitionTask(... "needs-input", "running" ...)` and before `chat.handleClientSend`, gather + render + fold into content. Because `replyToTask` does not create a `task_runs` row itself (the resume reuses the existing run), stamp the comments with the latest run for this task. Add a helper read:

```ts
import { gatherUnconsumedUserComments, markCommentsConsumed } from "../../db/task-comments.js";
import { renderCommentsForRunner } from "./comments.js";
import { listTaskRuns } from "../../db/projects.js"; // already imported elsewhere; ensure present
```

Then:

```ts
    const unconsumed = await gatherUnconsumedUserComments(this.deps.db, input.taskId);
    const commentBlock = renderCommentsForRunner(unconsumed);
    const content = commentBlock ? `${input.content}\n\n${commentBlock}` : input.content;

    await this.deps.chat.handleClientSend({
      userId: input.userId,
      threadId: task.executionThreadId,
      content,
      sourceClientId: input.sourceClientId,
      ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
    });

    if (unconsumed.length > 0) {
      const runs = await listTaskRuns(this.deps.db, input.taskId);
      const latestRun = runs.at(-1);
      if (latestRun) {
        await markCommentsConsumed(this.deps.db, unconsumed.map((c) => c.id), latestRun.id);
      }
    }
```

Replace the existing `await this.deps.chat.handleClientSend({...content: input.content...})` call with the version above (using `content`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cloud/src/domains/project/comments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/domains/project/index.ts packages/cloud/src/domains/project/comments.test.ts
git commit -m "feat(cloud): fold comments into needs-input reply"
```

---

## Task 9: Domain — addUserComment / deleteUserComment / broadcastComment

**Files:**
- Modify: `packages/cloud/src/domains/project/index.ts`
- Test: `packages/cloud/src/domains/project/comments.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
it("addUserComment inserts an inert user comment and broadcasts", async () => {
  const c = await domain.addUserComment({ taskId, userId, body: "记一笔" });
  expect(c.author).toBe("user");
  expect(c.consumedByRunId).toBeNull();
  const list = await listComments(db, taskId);
  expect(list.some((x) => x.body === "记一笔")).toBe(true);
  // task state unchanged (inert):
  const task = await domain.getTask(taskId);
  expect(task!.state).toBe(/* the seeded state, e.g. "done" */ "done");
});

it("deleteUserComment removes only un-consumed user comments", async () => {
  const c = await domain.addUserComment({ taskId, userId, body: "x" });
  await domain.deleteUserComment(c.id);
  expect(await listComments(db, taskId)).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cloud/src/domains/project/comments.test.ts`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement**

In `index.ts`, import the db helpers (some already imported in Task 8):

```ts
import { insertComment, listComments as dbListComments, getComment, deleteComment } from "../../db/task-comments.js";
```

Add a private broadcast helper near `broadcastTask` (~line 168 area). `broadcastTask` uses `this.deps.clients.broadcastProject(task.projectId, ...)`; comments only need per-task subscribers, so:

```ts
  private broadcastComment(comment: TaskComment, kind: "created" | "deleted"): void {
    this.deps.clients.broadcastTask(comment.taskId, { t: "task-comment", kind, comment });
  }
```

Add `import type { TaskComment } from "@cogni/contract";` if not already imported.

Add the public methods (place near `replyToTask` / other use-cases):

```ts
  /** Inert human comment — recorded only; never contacts the runner. */
  async addUserComment(input: { taskId: string; userId: string; body: string }): Promise<TaskComment> {
    const task = await dbGetTask(this.deps.db, input.taskId);
    if (!task) throw new Error(`addUserComment: task ${input.taskId} not found`);
    const comment = await insertComment(this.deps.db, {
      taskId: input.taskId,
      author: "user",
      body: input.body,
      state: task.state,
      authorUserId: input.userId,
    });
    this.broadcastComment(comment, "created");
    return comment;
  }

  async listComments(taskId: string): Promise<TaskComment[]> {
    return dbListComments(this.deps.db, taskId);
  }

  async deleteUserComment(commentId: string): Promise<void> {
    const comment = await getComment(this.deps.db, commentId);
    if (!comment) return;
    if (comment.author !== "user") throw new Error("cannot delete a worker comment");
    if (comment.consumedByRunId) throw new Error("cannot delete a consumed comment");
    await deleteComment(this.deps.db, commentId);
    this.broadcastComment(comment, "deleted");
  }
```

(If you inlined the broadcast in Task 6, replace those inline calls with `this.broadcastComment(note, "created")` now.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cloud/src/domains/project/comments.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/domains/project/index.ts packages/cloud/src/domains/project/comments.test.ts
git commit -m "feat(cloud): addUserComment / deleteUserComment domain methods"
```

---

## Task 10: Domain — moveTaskToState (kanban drag target)

**Files:**
- Modify: `packages/cloud/src/domains/project/index.ts`
- Test: `packages/cloud/src/domains/project/comments.test.ts` or a new `move-task.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cloud/src/domains/project/move-task.test.ts` (mirror the lifecycle/orchestrator harness). Cover the common mappings:

```ts
it("done → queued re-queues via retry path", async () => {
  // seed a done task with retries=0
  const updated = await domain.moveTaskToState(taskId, "queued");
  expect(updated.state).toBe("queued");
  expect(updated.retries).toBe(1); // retry incremented
});

it("reviewing → done accepts (merge gate)", async () => {
  // seed reviewing task; fake hostRpc merge succeeds
  const updated = await domain.moveTaskToState(taskId, "done");
  expect(updated.state).toBe("done");
});

it("same state is a no-op", async () => {
  // seed running task
  const updated = await domain.moveTaskToState(taskId, "running");
  expect(updated.state).toBe("running");
});

it("running → queued stops runner then re-queues", async () => {
  // seed running task with a runner session; assert cancel/detach was invoked then state=queued
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cloud/src/domains/project/move-task.test.ts`
Expected: FAIL — `moveTaskToState` undefined.

- [ ] **Step 3: Implement**

Add to `index.ts`. Reuse the existing use-case methods (`retryTask`, `acceptTask`, `cancelTask`) wherever they fit, and `transitionTask` for direct hops. Import `LEGAL_TRANSITIONS` from `./lifecycle.js`.

```ts
  /**
   * Kanban drag-to-column. Maps a target column to the lifecycle action that
   * lands the task in that column. Re-activations from terminal states compose
   * through the retry path; moving out of `running` stops the runner first;
   * genuinely-incoherent targets are applied as a manual state override.
   */
  async moveTaskToState(taskId: string, to: TaskState): Promise<ProjectTask> {
    const task = await dbGetTask(this.deps.db, taskId);
    if (!task) throw new Error(`moveTaskToState: task ${taskId} not found`);
    const from = task.state;
    if (from === to) return task; // no-op

    switch (to) {
      case "queued": {
        // Re-queue. Terminal states use retry; active states cancel→queue.
        if (from === "done" || from === "failed" || from === "cancelled") {
          return this.retryTask(taskId);
        }
        // active (running / needs-input / reviewing): stop runner, then queue.
        await this.stopRunnerIfAny(task);
        const updated = await transitionTask(this.deps.db, taskId, from, "queued", {
          startedAt: null, completedAt: null,
        });
        this.broadcastTask(updated, "state-changed");
        return updated;
      }
      case "running": {
        // queued → force dispatch happens on next orchestrator tick; for the
        // drag we just ensure it's queued (orchestrator picks it up).
        if (from === "needs-input") {
          const updated = await transitionTask(this.deps.db, taskId, "needs-input", "running", { needsInputWhat: null });
          this.broadcastTask(updated, "state-changed");
          return updated;
        }
        // terminal or queued → route to queued; orchestrator dispatches.
        return this.moveTaskToState(taskId, "queued");
      }
      case "reviewing": {
        if (from === "running") {
          const updated = await transitionTask(this.deps.db, taskId, "running", "reviewing", {});
          this.broadcastTask(updated, "state-changed");
          return updated;
        }
        return this.forceState(task, "reviewing");
      }
      case "done": {
        if (from === "reviewing") return this.acceptTask(taskId);
        if (from === "running") {
          await this.stopRunnerIfAny(task);
          const updated = await transitionTask(this.deps.db, taskId, "running", "done", {});
          this.broadcastTask(updated, "state-changed");
          return updated;
        }
        return this.forceState(task, "done");
      }
      case "needs-input": {
        if (from === "running") {
          const updated = await transitionTask(this.deps.db, taskId, "running", "needs-input", {});
          this.broadcastTask(updated, "state-changed");
          return updated;
        }
        return this.forceState(task, "needs-input");
      }
      default:
        return task;
    }
  }

  /** Manual state override for targets with no coherent lifecycle action. */
  private async forceState(task: ProjectTask, to: TaskState): Promise<ProjectTask> {
    await this.stopRunnerIfAny(task);
    // Bypass LEGAL_TRANSITIONS via a direct row update — this is a deliberate
    // user override. Reuse the db updateTaskState helper (no transition guard).
    const updated = await dbUpdateTaskState(this.deps.db, task.id, to, {});
    if (!updated) throw new Error(`forceState: task ${task.id} vanished`);
    this.broadcastTask(updated, "state-changed");
    return updated;
  }

  /** Best-effort runner stop when moving a task out of running. */
  private async stopRunnerIfAny(task: ProjectTask): Promise<void> {
    if (task.state !== "running" && task.state !== "needs-input") return;
    try {
      await this.cancelTaskRunnerSession(task); // existing private path used by cancelTask
    } catch (err) {
      this.deps.logger?.warn?.({ taskId: task.id, err: String(err) }, "stopRunnerIfAny: detach failed");
    }
  }
```

> **Adapt to the real code:** `cancelTask` already contains the runner-session-close logic (read `index.ts:354+`). Extract that block into a private `cancelTaskRunnerSession(task)` and call it from both `cancelTask` and `stopRunnerIfAny` (DRY). `dbUpdateTaskState` is the existing `updateTaskState` from `db/projects.ts` (imported as `dbUpdateTaskState` or its real name — match the file's import alias). If `updateTaskState` enforces no guard, it is the right primitive for `forceState`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cloud/src/domains/project/move-task.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/domains/project/index.ts packages/cloud/src/domains/project/move-task.test.ts
git commit -m "feat(cloud): moveTaskToState for kanban drag"
```

---

## Task 11: Orchestrator preamble — require a handoff note

**Files:**
- Modify: `packages/cloud/src/domains/project/orchestrator.ts` (`FILE_COMMIT_RULES` ~line 410)

- [ ] **Step 1: Add the instruction**

In the `FILE_COMMIT_RULES` array, add a bullet (before the final `""`):

```ts
        "- Before reporting completion or asking a question, your FINAL message must be a structured handoff note with three short parts: (1) 做了什么 — what you did; (2) 交付物在哪 — where the deliverable is (files / branch); (3) 下一步人类该检查什么 — what the human should review next.",
```

- [ ] **Step 2: Verify existing orchestrator tests still pass**

Run: `pnpm vitest run packages/cloud/src/domains/project/orchestrator.test.ts`
Expected: PASS (the preamble text change is additive; if a test asserts exact message equality, update that expectation to include the new bullet).

- [ ] **Step 3: Commit**

```bash
git add packages/cloud/src/domains/project/orchestrator.ts
git commit -m "feat(cloud): instruct runner to emit a handoff note before completion"
```

---

## Task 12: Routes — comment endpoints

**Files:**
- Modify: `packages/cloud/src/routes/projects.ts` (after the task action routes, ~line 560+)
- Test: `packages/cloud/src/routes/*.test.ts` if a route test harness exists; otherwise rely on domain tests + a manual curl in Task 20.

- [ ] **Step 1: Add the routes**

In `routes/projects.ts`, add a zod body schema near the top with the other schemas:

```ts
const commentBodySchema = z.object({ body: z.string().min(1).max(8000) });
```

Add these route handlers inside the route-registration function (mirror the `ownedTask` + `deps.projectDomain` guard pattern used by `/reply`):

```ts
  app.get("/api/tasks/:taskId/comments", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const owned = await ownedTask(deps, c.req.param("taskId"), userId, tenantId);
    if (!owned) return c.json({ error: "not found" }, 404);
    if (!deps.projectDomain) return c.json({ error: "project domain unavailable" }, 503);
    return c.json(await deps.projectDomain.listComments(owned.task.id));
  });

  app.post("/api/tasks/:taskId/comments", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const owned = await ownedTask(deps, c.req.param("taskId"), userId, tenantId);
    if (!owned) return c.json({ error: "not found" }, 404);
    if (!deps.projectDomain) return c.json({ error: "project domain unavailable" }, 503);
    const parsed = commentBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
    try {
      const comment = await deps.projectDomain.addUserComment({
        taskId: owned.task.id, userId, body: parsed.data.body,
      });
      return c.json(comment, 201);
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });

  app.delete("/api/tasks/:taskId/comments/:commentId", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const owned = await ownedTask(deps, c.req.param("taskId"), userId, tenantId);
    if (!owned) return c.json({ error: "not found" }, 404);
    if (!deps.projectDomain) return c.json({ error: "project domain unavailable" }, 503);
    try {
      await deps.projectDomain.deleteUserComment(c.req.param("commentId"));
      return c.json({ ok: true });
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @cogni/cloud exec tsc --noEmit` (or `pnpm typecheck`)
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/cloud/src/routes/projects.ts
git commit -m "feat(cloud): task comment REST endpoints"
```

---

## Task 13: Route — task state PATCH (drag target)

**Files:**
- Modify: `packages/cloud/src/routes/projects.ts`

- [ ] **Step 1: Add the route**

Add a body schema near the others:

```ts
import { taskStateSchema } from "@cogni/contract"; // ensure imported
const moveStateSchema = z.object({ to: taskStateSchema });
```

Add the handler:

```ts
  app.patch("/api/tasks/:taskId/state", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const owned = await ownedTask(deps, c.req.param("taskId"), userId, tenantId);
    if (!owned) return c.json({ error: "not found" }, 404);
    if (!deps.projectDomain) return c.json({ error: "project domain unavailable" }, 503);
    const parsed = moveStateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
    try {
      const task = await deps.projectDomain.moveTaskToState(owned.task.id, parsed.data.to);
      return c.json(task);
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/cloud/src/routes/projects.ts
git commit -m "feat(cloud): PATCH task state route for kanban drag"
```

---

## Task 14: UI api client methods

**Files:**
- Modify: `packages/ui/src/transport/api.ts` (near `getTaskDetail` ~line 370)

- [ ] **Step 1: Implement methods**

Read the existing private `request`/`get`/`post` helpers in `api.ts` first (the `getTaskDetail`/`replyToTask` definitions show the exact helper names). Add, mirroring those:

```ts
  getTaskComments = (taskId: string): Promise<TaskComment[]> =>
    this.get(`/api/tasks/${taskId}/comments`);

  addTaskComment = (taskId: string, body: string): Promise<TaskComment> =>
    this.post(`/api/tasks/${taskId}/comments`, { body });

  deleteTaskComment = (taskId: string, commentId: string): Promise<{ ok: true }> =>
    this.del(`/api/tasks/${taskId}/comments/${commentId}`);

  moveTaskState = (taskId: string, to: TaskState): Promise<ProjectTask> =>
    this.patch(`/api/tasks/${taskId}/state`, { to });
```

Add `TaskComment`, `TaskState` to the existing `import type { ... } from "@cogni/contract";` line. If `this.del` / `this.patch` helpers don't exist, add them next to the existing `get`/`post` private methods following the same fetch + auth-header pattern (read the file — `post` shows the body/JSON shape and error handling to copy for `patch`; `getTaskDetail` shows `get`).

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @cogni/ui exec tsc --noEmit` (or `pnpm typecheck`)
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/transport/api.ts
git commit -m "feat(ui): api client methods for comments + move state"
```

---

## Task 15: ws-client — route task-comment frames

**Files:**
- Modify: `packages/ui/src/transport/ws-client.ts` (the `dispatch(frame)` function ~line 252, the `task-event` block)

- [ ] **Step 1: Implement routing**

In `dispatch`, right after the `if (frame.t === "task-event") { ... return; }` block, add:

```ts
    if (frame.t === "task-comment") {
      for (const s of taskSubs) {
        if (s.taskId === frame.comment.taskId) s.onFrame(frame);
      }
      return;
    }
```

`taskSubs` and the `TaskSubscription.onFrame` signature already accept `CloudToClient`, so no other change is needed — the per-task subscription created by `subscribeTask` will now receive `task-comment` frames too.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/transport/ws-client.ts
git commit -m "feat(ui): route task-comment frames to task subscribers"
```

---

## Task 16: useTaskComments hook

**Files:**
- Create: `packages/ui/src/hooks/useTaskComments.ts`

- [ ] **Step 1: Implement (mirrors useTaskDetail)**

```ts
/**
 * useTaskComments — the 主页面 comment feed for one task.
 *
 * Initial REST fetch + live `task-comment` deltas over the existing
 * `subscribe-task:<taskId>` channel. Posting a comment is inert server-side
 * (no lifecycle change); the new card lands via the WS echo.
 */
import { useCallback, useEffect, useState } from "react";
import type { TaskComment, CloudToClient } from "@cogni/contract";
import type { ApiClient } from "../transport/api.js";

export interface UseTaskCommentsResult {
  comments: TaskComment[];
  loading: boolean;
  add: (body: string) => Promise<void>;
  remove: (commentId: string) => Promise<void>;
}

export function useTaskComments(api: ApiClient, taskId: string): UseTaskCommentsResult {
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const cached = api.cache.get<TaskComment[]>(`task-comments:${taskId}`);
    setComments(cached ?? []);
    setLoading(!cached);
    try {
      const list = await api.getTaskComments(taskId);
      api.cache.set(`task-comments:${taskId}`, list);
      setComments(list);
    } finally {
      setLoading(false);
    }
  }, [api, taskId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const unsubscribe = api.wsClient.subscribeTask({
      taskId,
      onFrame: (frame: CloudToClient) => {
        if (frame.t !== "task-comment") return;
        if (frame.comment.taskId !== taskId) return;
        setComments((prev) => {
          let next: TaskComment[];
          if (frame.kind === "deleted") {
            next = prev.filter((c) => c.id !== frame.comment.id);
          } else if (prev.some((c) => c.id === frame.comment.id)) {
            next = prev.map((c) => (c.id === frame.comment.id ? frame.comment : c));
          } else {
            next = [...prev, frame.comment].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          }
          api.cache.set(`task-comments:${taskId}`, next);
          return next;
        });
      },
    });
    return unsubscribe;
  }, [api, taskId]);

  const add = useCallback(async (body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    await api.addTaskComment(taskId, trimmed);
  }, [api, taskId]);

  const remove = useCallback(async (commentId: string) => {
    await api.deleteTaskComment(taskId, commentId);
  }, [api, taskId]);

  return { comments, loading, add, remove };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/hooks/useTaskComments.ts
git commit -m "feat(ui): useTaskComments live feed hook"
```

---

## Task 17: TaskComments card-grid component + styles

**Files:**
- Create: `packages/ui/src/components/project/TaskComments.tsx`
- Modify: `packages/ui/src/components/project/task-detail.css`

- [ ] **Step 1: Implement the component**

```tsx
/**
 * TaskComments — the 主页面 comment feed card grid.
 *
 * Worker handoff cards (bot icon + state chip) and human comment cards
 * (avatar + delete affordance on own un-consumed cards) wrap in a grid,
 * chronological. A trailing dashed "+" card opens an inline composer.
 */
import { useState } from "react";
import type { TaskComment } from "@cogni/contract";
import type { ApiClient } from "../../transport/api.js";
import { useTaskComments } from "../../hooks/useTaskComments.js";
import { Composer } from "../Composer.js";
import { Markdown } from "../Markdown.js";
import { Icon } from "../icons.js";
import { STATE_COLOR } from "./ProjectBoard.js";

const STATE_CHIP: Record<string, string> = {
  done: "→ 完成", reviewing: "→ 待 Review", "needs-input": "→ 等待输入",
  running: "→ 进行中", queued: "→ 排队中", failed: "→ 失败", cancelled: "→ 已取消",
};

export function TaskComments({ api, taskId }: { api: ApiClient; taskId: string }) {
  const { comments, loading, add, remove } = useTaskComments(api, taskId);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft(""); setAdding(false);
    void add(text);
  };

  return (
    <section className="tc">
      <div className="tc__head">评论 · 交接说明</div>
      <div className="tc__grid">
        {comments.map((c) => (
          <CommentCard key={c.id} comment={c} onDelete={() => void remove(c.id)} />
        ))}
        {adding ? (
          <div className="tc__card tc__card--compose">
            <Composer draft={draft} setDraft={setDraft} onSubmit={submit} placeholder="写条说明,给下一次运行…" />
          </div>
        ) : (
          <button className="tc__card tc__card--add" onClick={() => setAdding(true)}>
            <span className="tc__add-plus">{Icon.plus ?? "+"}</span>
            <span className="tc__add-hint">{comments.length === 0 && !loading ? "给下一次运行留点说明…" : "新增评论"}</span>
          </button>
        )}
      </div>
    </section>
  );
}

function CommentCard({ comment, onDelete }: { comment: TaskComment; onDelete: () => void }) {
  const isWorker = comment.author === "worker";
  return (
    <div className={"tc__card" + (isWorker ? " tc__card--worker" : " tc__card--user")}>
      <div className="tc__card-head">
        <span className="tc__avatar">{isWorker ? (Icon.sparkle ?? "🤖") : (Icon.user ?? "🧑")}</span>
        {isWorker && (
          <span className="tc__chip" style={{ color: STATE_COLOR[comment.state] }}>
            {STATE_CHIP[comment.state] ?? comment.state}
          </span>
        )}
        {!isWorker && comment.consumedByRunId && <span className="tc__badge">已交给 worker</span>}
        {!isWorker && !comment.consumedByRunId && (
          <button className="tc__del" title="删除" onClick={onDelete}>{Icon.x}</button>
        )}
      </div>
      <div className="tc__card-body"><Markdown text={comment.body} /></div>
      <time className="tc__time">{formatAgo(comment.createdAt)}</time>
    </div>
  );
}

function formatAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
```

> **Icon check:** `Icon` may not have `plus` / `sparkle` / `user` keys. Open `packages/ui/src/components/icons.ts`; use whichever close keys exist (the `??` string fallbacks above keep it compiling either way). Keep the fallbacks.

- [ ] **Step 2: Add styles**

Append to `packages/ui/src/components/project/task-detail.css` (match the existing `--surface` / radius / border tokens used by `.td-card`):

```css
.tc { margin-top: 16px; }
.tc__head { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin-bottom: 10px; }
.tc__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; }
.tc__card { border-radius: 12px; border: 1px solid var(--border); background: var(--surface, #faf8f5); padding: 12px; display: flex; flex-direction: column; gap: 8px; min-height: 110px; }
.tc__card--worker { background: color-mix(in srgb, var(--accent) 6%, var(--surface, #faf8f5)); }
.tc__card-head { display: flex; align-items: center; gap: 6px; }
.tc__avatar { font-size: 14px; }
.tc__chip { font-size: 11px; font-weight: 600; }
.tc__badge { font-size: 10px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 1px 6px; }
.tc__del { margin-left: auto; background: none; border: none; cursor: pointer; opacity: .5; }
.tc__del:hover { opacity: 1; }
.tc__card-body { font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.tc__time { font-size: 11px; color: var(--muted); margin-top: auto; }
.tc__card--add { cursor: pointer; align-items: center; justify-content: center; border-style: dashed; color: var(--muted); gap: 4px; }
.tc__card--add:hover { border-color: var(--accent); color: var(--accent); }
.tc__add-plus { font-size: 22px; line-height: 1; }
.tc__add-hint { font-size: 12px; }
.tc__card--compose { min-height: auto; }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/project/TaskComments.tsx packages/ui/src/components/project/task-detail.css
git commit -m "feat(ui): TaskComments card-grid component"
```

---

## Task 18: Mount TaskComments in TaskDetail overview

**Files:**
- Modify: `packages/ui/src/components/project/TaskDetail.tsx` (the overview block ~line 192-211)

- [ ] **Step 1: Wire it in**

Add the import:

```ts
import { TaskComments } from "./TaskComments.js";
```

In the overview JSX, after the `<Actions ... />` line and before the closing `</>`:

```tsx
              <TaskComments api={api} taskId={taskId} />
```

- [ ] **Step 2: Verify in the running app**

Run: `pnpm --filter web dev`, open a project, open a task drawer's 主页面. The comment grid renders below the actions; "+" opens a composer; posting adds a card with no state change.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/project/TaskDetail.tsx
git commit -m "feat(ui): mount comment feed in task overview"
```

---

## Task 19: ProjectBoard free drag-and-drop

**Files:**
- Modify: `packages/ui/src/components/project/ProjectBoard.tsx` (`ColumnsView` ~line 209, `ColumnCard` ~line 233)

- [ ] **Step 1: Thread an `onMoveTask` callback to the board**

`ColumnsView` / `ProjectBoard` need an `api` (or a `moveTask(taskId, to)` callback). Read how `onOpenTask` is threaded from the page Shell into `ProjectBoard` → `ColumnsView` → `ColumnCard`, and add a parallel `onMoveTask?: (taskId: string, to: TaskState) => void` prop down the same path. At the Shell call site, pass `(taskId, to) => void api.moveTaskState(taskId, to)` (the board already has `api` available where `onOpenTask` is wired — match that).

- [ ] **Step 2: Make cards draggable + columns droppable**

In `ColumnCard`, add to the root element:

```tsx
      draggable
      onDragStart={(e) => { e.dataTransfer.setData("text/task-id", task.id); e.dataTransfer.effectAllowed = "move"; }}
```

In `ColumnsView`, the per-column wrapper (the element rendered per `COLUMN_STATES` entry) gets drop handlers:

```tsx
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/task-id");
              if (id) onMoveTask?.(id, state); // `state` is this column's TaskState
            }}
            onDragEnter={(e) => (e.currentTarget as HTMLElement).classList.add("kb-col--drop")}
            onDragLeave={(e) => (e.currentTarget as HTMLElement).classList.remove("kb-col--drop")}
```

(Also clear `kb-col--drop` in `onDrop`. `state` is the loop variable in the `COLUMN_STATES.map((state) => ...)` — it's already typed `TaskState`.)

- [ ] **Step 3: Add drop-zone highlight CSS**

Append to the board's CSS file (find where `.kb-col` / column classes live — likely `project-board.css` or inline; grep for `kb-col`):

```css
.kb-col--drop { outline: 2px dashed var(--accent); outline-offset: -4px; border-radius: 12px; }
```

- [ ] **Step 4: Verify in the running app**

Run: `pnpm --filter web dev`. Drag a `已完成` card onto 排队中 → it re-queues and (≤5s) flips to 进行中; any unconsumed comments inject into that run (verify via the runner thread in 执行记录). Drag onto the same column → no-op.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/project/ProjectBoard.tsx packages/ui/src/components/project/*.css
git commit -m "feat(ui): kanban free drag task cards to any column"
```

---

## Task 20: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole suite**

Run: `pnpm test`
Expected: all green, including the new `task-comments.test.ts`, `comments.test.ts`, `move-task.test.ts`, and extended `orchestrator.test.ts`.

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 3: Apply the migration to a dev DB (optional, manual)**

Run: `pnpm --filter @cogni/cloud exec drizzle-kit push`
Expected: `task_comments` created.

- [ ] **Step 4: End-to-end smoke (per spec §8 / §7)**

`pnpm build` then run cloud + a runner host + `pnpm --filter web dev`. Create a task, let it finish → a worker handoff card appears on 主页面. Add a human comment (no state change). Drag the card to 排队中 → it reruns and the runner thread shows the 人类补充说明 block.

- [ ] **Step 5: Final commit (changelog)**

Write `changelog/<timestamp>.md` summarizing the feature (per repo convention), then:

```bash
git add changelog/
git commit -m "chore: changelog for task comment cards"
```

---

## Self-Review Notes (for the implementer)

- **Order matters for the broadcast helper:** Task 6 references `broadcastComment` which is formally added in Task 9. Either implement Task 9's helper first or use the inline broadcast noted in Task 6 Step 3.
- **`forceState` bypasses `LEGAL_TRANSITIONS` deliberately** (manual override per spec §7). Confirm `updateTaskState` in `db/projects.ts` has no transition guard before using it; if it does, write a thin raw-update helper in `db/projects.ts` instead.
- **`stopRunnerIfAny` must reuse `cancelTask`'s existing session-close block** — extract it to a private method rather than duplicating (DRY).
- **Naming consistency:** db layer uses `insertComment`/`listComments`/`deleteComment`/`gatherUnconsumedUserComments`/`markCommentsConsumed`/`getLatestAssistantMessage`; domain uses `addUserComment`/`listComments`/`deleteUserComment`/`moveTaskToState`/`captureWorkerNote`/`renderCommentsForRunner`; api client uses `getTaskComments`/`addTaskComment`/`deleteTaskComment`/`moveTaskState`. Keep these exact.
