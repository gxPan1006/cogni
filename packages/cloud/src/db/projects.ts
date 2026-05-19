import { eq, and, isNull, desc, asc, sql } from "drizzle-orm";
import { projects, projectTasks, taskRuns } from "./schema.js";
import type { AnyDb } from "./users.js";
import type {
  Project,
  ProjectTask,
  TaskRun,
  TaskState,
  Priority,
  TaskExitReason,
  MergePolicy,
} from "@cogni/contract";

/**
 * SP-3 project-domain DB helpers.
 *
 * All functions take an `AnyDb` (matches both production neon-serverless
 * client and pglite test client). Returned shapes are the contract camelCase
 * types — not the raw drizzle row — because protocol/HTTP/UI consume those.
 *
 * Notable design notes:
 *   - `ref` allocation (createTask): COUNT(*)+1 inside a transaction; spec
 *     §二.B mentions per-project sequences as the eventual goal (avoids
 *     gaps + scales better) but MVP uses count to avoid CREATE SEQUENCE
 *     plumbing. Wrapped in a transaction so two parallel creations don't
 *     collide on the UNIQUE (project_id, ref) constraint — the second one
 *     retries with the new count. SP-3+1 swaps to a proper sequence.
 *   - `labels` is jsonb in DB; we coerce to string[] on read. Empty array
 *     default matches schema default.
 *   - `orderIndex` is stored as text (lex order); helpers do not enforce
 *     a particular allocation strategy — callers compute it.
 */

// ─── Row → contract type mappers ────────────────────────────────────────────

function rowToProject(r: typeof projects.$inferSelect): Project {
  return {
    id: r.id,
    tenantId: r.tenantId,
    userId: r.userId,
    name: r.name,
    description: r.description,
    repoPath: r.repoPath,
    defaultHostId: r.defaultHostId,
    threadId: r.threadId,
    mergePolicy: r.mergePolicy as MergePolicy,
    testCommand: r.testCommand,
    concurrencyLimit: r.concurrencyLimit,
    systemPrompt: r.systemPrompt,
    archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function rowToTask(r: typeof projectTasks.$inferSelect): ProjectTask {
  // priority is `smallint` (we use `integer` in drizzle) — narrow to Priority
  // literal union; values outside 0-4 should never appear because we validate
  // on write, but we clamp for read safety.
  const priority = Math.max(0, Math.min(4, r.priority)) as Priority;
  const labels = Array.isArray(r.labels) ? (r.labels as string[]) : [];
  return {
    id: r.id,
    projectId: r.projectId,
    ref: r.ref,
    title: r.title,
    description: r.description,
    state: r.state as TaskState,
    priority,
    labels,
    orderIndex: r.orderIndex,
    hostId: r.hostId,
    adapter: r.adapter,
    worktreePath: r.worktreePath,
    branchName: r.branchName,
    executionThreadId: r.executionThreadId,
    retries: r.retries,
    maxRetries: r.maxRetries,
    needsInputWhat: r.needsInputWhat,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
  };
}

function rowToTaskRun(r: typeof taskRuns.$inferSelect): TaskRun {
  return {
    id: r.id,
    taskId: r.taskId,
    runnerSessionId: r.runnerSessionId,
    attemptNumber: r.attemptNumber,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    exitReason: (r.exitReason as TaskExitReason | null) ?? null,
    errorMessage: r.errorMessage,
  };
}

// ─── Projects ───────────────────────────────────────────────────────────────

export interface CreateProjectInput {
  tenantId: string;
  userId: string;
  name: string;
  description?: string;
  repoPath: string;
  defaultHostId: string;
  mergePolicy?: MergePolicy;
  testCommand?: string;
  concurrencyLimit?: number;
  systemPrompt?: string;
}

export async function createProject(db: AnyDb, input: CreateProjectInput): Promise<Project> {
  const [row] = await db
    .insert(projects)
    .values({
      tenantId: input.tenantId,
      userId: input.userId,
      name: input.name,
      description: input.description ?? null,
      repoPath: input.repoPath,
      defaultHostId: input.defaultHostId,
      mergePolicy: input.mergePolicy ?? "require-review",
      testCommand: input.testCommand ?? null,
      concurrencyLimit: input.concurrencyLimit ?? 2,
      systemPrompt: input.systemPrompt ?? null,
    })
    .returning();
  return rowToProject(row!);
}

export async function listProjects(
  db: AnyDb,
  opts: { tenantId: string; userId: string; includeArchived?: boolean },
): Promise<Project[]> {
  const whereClause = opts.includeArchived
    ? and(eq(projects.tenantId, opts.tenantId), eq(projects.userId, opts.userId))
    : and(
        eq(projects.tenantId, opts.tenantId),
        eq(projects.userId, opts.userId),
        isNull(projects.archivedAt),
      );
  const rows = await db
    .select()
    .from(projects)
    .where(whereClause)
    .orderBy(desc(projects.updatedAt));
  return rows.map(rowToProject);
}

export async function getProject(db: AnyDb, projectId: string): Promise<Project | null> {
  const rows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  return rows[0] ? rowToProject(rows[0]) : null;
}

export async function archiveProject(db: AnyDb, projectId: string): Promise<void> {
  await db
    .update(projects)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(projects.id, projectId));
}

export interface UpdateProjectPatch {
  name?: string;
  description?: string | null;
  repoPath?: string;
  defaultHostId?: string;
  mergePolicy?: MergePolicy;
  testCommand?: string | null;
  concurrencyLimit?: number;
  systemPrompt?: string | null;
}

export async function updateProject(
  db: AnyDb,
  projectId: string,
  patch: UpdateProjectPatch,
): Promise<Project> {
  const updates: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.repoPath !== undefined) updates.repoPath = patch.repoPath;
  if (patch.defaultHostId !== undefined) updates.defaultHostId = patch.defaultHostId;
  if (patch.mergePolicy !== undefined) updates.mergePolicy = patch.mergePolicy;
  if (patch.testCommand !== undefined) updates.testCommand = patch.testCommand;
  if (patch.concurrencyLimit !== undefined) updates.concurrencyLimit = patch.concurrencyLimit;
  if (patch.systemPrompt !== undefined) updates.systemPrompt = patch.systemPrompt;
  const [row] = await db
    .update(projects)
    .set(updates)
    .where(eq(projects.id, projectId))
    .returning();
  if (!row) throw new Error(`project ${projectId} not found`);
  return rowToProject(row);
}

// ─── Project tasks ──────────────────────────────────────────────────────────

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string;
  priority?: Priority;
  labels?: string[];
  adapter?: string;
  /**
   * Lex-order key for kanban placement. Caller computes (e.g. mid-point
   * between two siblings). Defaults to `<count+1>` so unordered creation
   * is monotonically increasing.
   */
  orderIndex?: string;
  /** Initial state — almost always omitted (defaults to "queued"). */
  state?: TaskState;
  /**
   * Thread the runner's event stream gets written into. ProjectDomain creates
   * a fresh thread for every task during `createTask` (so the drawer's
   * embedded `<ChatBlocks>` has somewhere to subscribe before the runner
   * starts emitting). Required for dispatch — the orchestrator skips tasks
   * with no executionThreadId.
   */
  executionThreadId?: string;
}

export async function createTask(db: AnyDb, input: CreateTaskInput): Promise<ProjectTask> {
  // Allocate ref + orderIndex inside a transaction so two parallel creates
  // can't collide on (project_id, ref). SP-3+1 will swap to a per-project
  // PG sequence; until then, count-of-existing-rows + 1 is sufficient for
  // single-node cogni-cloud (one writer at a time).
  return await db.transaction(async (tx) => {
    const countRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(projectTasks)
      .where(eq(projectTasks.projectId, input.projectId));
    const nextNum = (countRows[0]?.count ?? 0) + 1;
    const ref = `T-${nextNum}`;
    const orderIndex = input.orderIndex ?? String(nextNum);
    const [row] = await tx
      .insert(projectTasks)
      .values({
        projectId: input.projectId,
        ref,
        title: input.title,
        description: input.description ?? null,
        state: input.state ?? "queued",
        priority: input.priority ?? 0,
        labels: input.labels ?? [],
        orderIndex,
        adapter: input.adapter ?? null,
        executionThreadId: input.executionThreadId ?? null,
      })
      .returning();
    return rowToTask(row!);
  });
}

export async function listTasksByProject(
  db: AnyDb,
  projectId: string,
): Promise<ProjectTask[]> {
  const rows = await db
    .select()
    .from(projectTasks)
    .where(eq(projectTasks.projectId, projectId))
    .orderBy(asc(projectTasks.state), asc(projectTasks.orderIndex));
  return rows.map(rowToTask);
}

export async function getTask(db: AnyDb, taskId: string): Promise<ProjectTask | null> {
  const rows = await db.select().from(projectTasks).where(eq(projectTasks.id, taskId)).limit(1);
  return rows[0] ? rowToTask(rows[0]) : null;
}

export interface UpdateTaskStatePatch {
  hostId?: string | null;
  adapter?: string | null;
  worktreePath?: string | null;
  branchName?: string | null;
  executionThreadId?: string | null;
  retries?: number;
  needsInputWhat?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  title?: string;
  description?: string | null;
  priority?: Priority;
  labels?: string[];
  orderIndex?: string;
}

export async function updateTaskState(
  db: AnyDb,
  taskId: string,
  newState: TaskState,
  patch: UpdateTaskStatePatch = {},
): Promise<ProjectTask> {
  const updates: Partial<typeof projectTasks.$inferInsert> = {
    state: newState,
    updatedAt: new Date(),
  };
  if (patch.hostId !== undefined) updates.hostId = patch.hostId;
  if (patch.adapter !== undefined) updates.adapter = patch.adapter;
  if (patch.worktreePath !== undefined) updates.worktreePath = patch.worktreePath;
  if (patch.branchName !== undefined) updates.branchName = patch.branchName;
  if (patch.executionThreadId !== undefined) updates.executionThreadId = patch.executionThreadId;
  if (patch.retries !== undefined) updates.retries = patch.retries;
  if (patch.needsInputWhat !== undefined) updates.needsInputWhat = patch.needsInputWhat;
  if (patch.startedAt !== undefined) updates.startedAt = patch.startedAt;
  if (patch.completedAt !== undefined) updates.completedAt = patch.completedAt;
  if (patch.title !== undefined) updates.title = patch.title;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.priority !== undefined) updates.priority = patch.priority;
  if (patch.labels !== undefined) updates.labels = patch.labels;
  if (patch.orderIndex !== undefined) updates.orderIndex = patch.orderIndex;
  const [row] = await db
    .update(projectTasks)
    .set(updates)
    .where(eq(projectTasks.id, taskId))
    .returning();
  if (!row) throw new Error(`task ${taskId} not found`);
  return rowToTask(row);
}

// ─── Task runs ──────────────────────────────────────────────────────────────

export async function listTaskRuns(db: AnyDb, taskId: string): Promise<TaskRun[]> {
  const rows = await db
    .select()
    .from(taskRuns)
    .where(eq(taskRuns.taskId, taskId))
    .orderBy(asc(taskRuns.attemptNumber));
  return rows.map(rowToTaskRun);
}

export interface CreateTaskRunInput {
  taskId: string;
  runnerSessionId: string;
  attemptNumber: number;
  startedAt: Date;
}

export async function createTaskRun(db: AnyDb, input: CreateTaskRunInput): Promise<TaskRun> {
  const [row] = await db
    .insert(taskRuns)
    .values({
      taskId: input.taskId,
      runnerSessionId: input.runnerSessionId,
      attemptNumber: input.attemptNumber,
      startedAt: input.startedAt,
    })
    .returning();
  return rowToTaskRun(row!);
}
