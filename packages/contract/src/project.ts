/**
 * SP-3 project domain — core entity types.
 *
 * cogni in SP-1/SP-2 was an "AI chat with a per-thread runner session".
 * SP-3 layers a new business domain on top: **monitored AI worker
 * orchestration**. A user creates a `Project` (rooted at a git repo on
 * some host), then files `ProjectTask` rows inside it. Each task runs in
 * its own git worktree on the project's default host, in a sticky branch
 * (`task/<lowercase-ref>`); the cloud reconcile loop dispatches queued
 * tasks within the project's concurrency cap. Each (re)start of a task
 * produces a `TaskRun` row for audit + retry-history UI.
 *
 * Lifecycle (see spec §四):
 *   queued → running → (needs-input ⇄ running)* → done
 *                                              ↘  reviewing → done | failed
 *   anywhere → failed | cancelled
 *
 * These contract types are consumed by:
 *   - cloud DB layer (`packages/cloud/src/db/projects.ts`) maps drizzle
 *     rows → these camelCase shapes (DB itself is snake_case)
 *   - cloud HTTP routes (`packages/cloud/src/routes/projects.ts`) return
 *     these shapes in JSON
 *   - WS protocol (`packages/contract/src/protocol.ts`) carries these
 *     in `project-event` / `task-event` push payloads
 *   - UI hooks (`packages/ui/src/hooks/useProject*.ts`) treat these as
 *     the source of truth for renderable state.
 *
 * Zod schemas (`*Schema`) are exported alongside each interface so wire
 * crossings (HTTP body, WS frame, host RPC) can validate at the boundary.
 * Inferring `z.infer<typeof XSchema>` would also work but we publish the
 * `interface` form explicitly to keep API docs / IDE hover human-readable.
 */

import { z } from "zod";

// ─── Enums / unions ─────────────────────────────────────────────────────────

export const MERGE_POLICIES = ["require-review", "auto-merge", "auto-merge-if-tests-pass"] as const;
export type MergePolicy = (typeof MERGE_POLICIES)[number];
export const mergePolicySchema = z.enum(MERGE_POLICIES);

export const TASK_STATES = [
  "queued",
  "running",
  "needs-input",
  "reviewing",
  "done",
  "failed",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const taskStateSchema = z.enum(TASK_STATES);

/**
 * Linear-borrowed numeric priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low.
 * Wire format is a small integer for cheap sort; UI maps it to label+icon.
 */
export const PRIORITIES = [0, 1, 2, 3, 4] as const;
export type Priority = (typeof PRIORITIES)[number];
export const prioritySchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);

export const TASK_EXIT_REASONS = [
  "done",
  "failed",
  "timeout",
  "host-disconnect",
  "cancelled",
  "business-clarification",
] as const;
export type TaskExitReason = (typeof TASK_EXIT_REASONS)[number];
export const taskExitReasonSchema = z.enum(TASK_EXIT_REASONS);

// ─── Project ────────────────────────────────────────────────────────────────

/**
 * A project = one repo-rooted "workspace" the user supervises. Lives on a
 * single default host (SP-3 does not migrate projects across hosts); a
 * user can have many projects per host. `repoPath` is an absolute path
 * on that host's local disk.
 *
 * `archivedAt != null` is the soft-delete signal — archived projects are
 * hidden by default in lists but rows + history remain queryable.
 *
 * `threadId` is reserved for SP-4 Workspace Chat (a project-level
 * conversation distinct from per-task `executionThreadId`); SP-3 stores
 * the FK but no code paths read it yet.
 */
export interface Project {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  description: string | null;
  repoPath: string;
  defaultHostId: string;
  threadId: string | null;
  mergePolicy: MergePolicy;
  testCommand: string | null;
  concurrencyLimit: number;
  systemPrompt: string | null;
  /**
   * SP-3+1: when true, after a task's branch merges into the project's main
   * the host also runs `git push origin main`, so accepted work syncs to the
   * remote (e.g. GitHub) without a manual push. Default false — a project on a
   * repo with no `origin` remote, or one the user wants to keep local, just
   * skips the push.
   */
  pushToRemote: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const projectSchema: z.ZodType<Project> = z.object({
  id: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  repoPath: z.string(),
  defaultHostId: z.string(),
  threadId: z.string().nullable(),
  mergePolicy: mergePolicySchema,
  testCommand: z.string().nullable(),
  concurrencyLimit: z.number().int().min(1).max(16),
  systemPrompt: z.string().nullable(),
  pushToRemote: z.boolean(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ─── ProjectTask ────────────────────────────────────────────────────────────

/**
 * One unit of work inside a project. The orchestrator drives state along
 * the lifecycle (spec §四); `worktreePath` / `branchName` / `hostId`
 * become non-null when state first transitions `queued → running` and
 * stick until the task is reaped (worktree cleaned on terminal states).
 *
 * `ref` is project-scoped human-readable ID ("MYAPP-1"); allocated at
 * creation via the project's per-project sequence (or atomic count+1 in
 * SP-3 MVP). Unique within `(projectId, ref)`.
 *
 * `executionThreadId` carries the runner's event stream (re-uses SP-1
 * `threads` + `events`); the TaskDetail drawer subscribes to it.
 *
 * `needsInputWhat` is populated only while state === "needs-input"; it's
 * the one-line summary of the business question the runner emitted.
 */
export interface ProjectTask {
  id: string;
  projectId: string;
  ref: string;
  title: string;
  description: string | null;
  state: TaskState;
  priority: Priority;
  labels: string[];
  orderIndex: string;
  hostId: string | null;
  adapter: string | null;
  worktreePath: string | null;
  branchName: string | null;
  executionThreadId: string | null;
  retries: number;
  maxRetries: number;
  needsInputWhat: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export const projectTaskSchema: z.ZodType<ProjectTask> = z.object({
  id: z.string(),
  projectId: z.string(),
  ref: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  state: taskStateSchema,
  priority: prioritySchema,
  labels: z.array(z.string()),
  // `orderIndex` is a lexicographic decimal string ("1", "1.5", "2") so
  // drag-rearrange in the kanban can insert between any two siblings without
  // an O(N) renumber. Wire type is string for precision; comparison is numeric.
  orderIndex: z.string(),
  hostId: z.string().nullable(),
  adapter: z.string().nullable(),
  worktreePath: z.string().nullable(),
  branchName: z.string().nullable(),
  executionThreadId: z.string().nullable(),
  retries: z.number().int().min(0),
  maxRetries: z.number().int().min(0),
  needsInputWhat: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

// ─── TaskRun ────────────────────────────────────────────────────────────────

/**
 * A single (re)attempt of a task. Created at every `queued → running`
 * transition. Maps 1:1 to a SP-1 `runner_sessions` row via
 * `runnerSessionId` (SP-3 adds nullable `task_id` on `runner_sessions`).
 *
 * Resume vs Retry:
 *   - Resume (host reconnect, network blip): same task_run row; runner
 *     session is re-attached via SP-1 `session-resume` capability.
 *   - Retry (failure → new attempt): new task_run row; new runner
 *     session; `attemptNumber` increments. Worktree is reused (sticky).
 */
export interface TaskRun {
  id: string;
  taskId: string;
  runnerSessionId: string;
  attemptNumber: number;
  startedAt: string;
  endedAt: string | null;
  exitReason: TaskExitReason | null;
  errorMessage: string | null;
}

export const taskRunSchema: z.ZodType<TaskRun> = z.object({
  id: z.string(),
  taskId: z.string(),
  runnerSessionId: z.string(),
  attemptNumber: z.number().int().min(1),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  exitReason: taskExitReasonSchema.nullable(),
  errorMessage: z.string().nullable(),
});

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

// ─── Event-kind unions used by WS push payloads ─────────────────────────────

export const PROJECT_EVENT_KINDS = ["created", "updated", "archived", "deleted"] as const;
export type ProjectEventKind = (typeof PROJECT_EVENT_KINDS)[number];
export const projectEventKindSchema = z.enum(PROJECT_EVENT_KINDS);

export const TASK_EVENT_KINDS = ["created", "updated", "deleted", "state-changed"] as const;
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];
export const taskEventKindSchema = z.enum(TASK_EVENT_KINDS);
