/**
 * DB layer for `task_comments` — the 主页面 comment feed.
 *
 * Worker handoff notes (`author='worker'`) are inserted by the project domain
 * at lifecycle transitions; inert human notes (`author='user'`) are inserted
 * via `addUserComment` and only marked `consumed_by_run_id` once a later run
 * carries them into the runner context.
 */
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
