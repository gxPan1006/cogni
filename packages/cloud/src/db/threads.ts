import { eq, ne, and, desc, asc, isNull, isNotNull, notInArray } from "drizzle-orm";
import { threads, messages, projects, projectTasks } from "./schema.js";
import type { AnyDb } from "./users.js";
import type { ThreadSummary, ThreadDetail, MessageView, Role } from "@cogni/contract";

export async function createThread(
  db: AnyDb,
  input: { userId: string; tenantId: string; title?: string },
): Promise<ThreadSummary> {
  const [row] = await db
    .insert(threads)
    .values({ userId: input.userId, tenantId: input.tenantId, title: input.title ?? "New chat" })
    .returning();
  return { id: row!.id, title: row!.title, updatedAt: row!.updatedAt.toISOString() };
}

export async function listThreads(db: AnyDb, userId: string): Promise<ThreadSummary[]> {
  // Threads that back a project task's execution — hidden from the Chat sidebar
  // (they're surfaced inside the task detail, not as standalone conversations).
  const taskThreadIds = db
    .select({ id: projectTasks.executionThreadId })
    .from(projectTasks)
    .where(isNotNull(projectTasks.executionThreadId));
  const rows = await db
    .select()
    .from(threads)
    // The Chat sidebar is for ordinary conversations only. Exclude:
    //   - kind='workspace' orchestrator sessions (live in the chat bubble), and
    //   - project task-execution threads (live in the task detail drawer).
    .where(
      and(
        eq(threads.userId, userId),
        ne(threads.kind, "workspace"),
        isNull(threads.deletedAt),
        notInArray(threads.id, taskThreadIds),
      ),
    )
    .orderBy(desc(threads.updatedAt));
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() }));
}

export async function getThreadDetail(db: AnyDb, threadId: string): Promise<ThreadDetail | null> {
  // The messages query only needs threadId (already known), not the thread row,
  // so both queries can fly in parallel — saves one server→Neon round-trip per
  // thread open. (On a remote DB that round-trip is the bulk of the handler's
  // own latency; the client-side cost is dominated by transport, see below.)
  const [t, msgs] = await Promise.all([
    db
      .select()
      .from(threads)
      .where(and(eq(threads.id, threadId), isNull(threads.deletedAt)))
      .limit(1),
    db
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(asc(messages.createdAt)),
  ]);
  if (!t[0]) return null;
  return {
    id: t[0].id,
    title: t[0].title,
    messages: msgs.map(toMessageView),
  };
}

/** Authorization check: does this thread exist AND belong to this user? */
export async function threadBelongsToUser(
  db: AnyDb,
  threadId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: threads.id })
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId), isNull(threads.deletedAt)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Soft-delete a thread (sidebar "删除"). Sets deleted_at=now so the row drops
 * out of listThreads / getThreadDetail / threadBelongsToUser while its message
 * + event history stays referentially intact. Returns the owner's userId so the
 * route can scope the `thread-deleted` broadcast without a second query; null
 * if the thread doesn't exist or was already deleted (idempotent).
 */
export async function softDeleteThread(
  db: AnyDb,
  threadId: string,
): Promise<{ userId: string } | null> {
  const [row] = await db
    .update(threads)
    .set({ deletedAt: new Date() })
    .where(and(eq(threads.id, threadId), isNull(threads.deletedAt)))
    .returning();
  if (!row) return null;
  return { userId: row.userId };
}

export async function appendMessage(
  db: AnyDb,
  input: {
    threadId: string;
    role: Role;
    content: string;
    attachments?: { name: string; size: number }[];
  },
): Promise<MessageView> {
  const [row] = await db
    .insert(messages)
    .values({
      threadId: input.threadId,
      role: input.role,
      content: input.content,
      attachmentsJson:
        input.attachments && input.attachments.length > 0 ? input.attachments : null,
    })
    .returning();
  return toMessageView(row!);
}

export async function touchThread(db: AnyDb, threadId: string): Promise<void> {
  await db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId));
}

/**
 * Rewrite the thread's title (used by the auto-titling RPC after the first
 * round). Returns the updated row's userId so the caller can scope the
 * `thread-meta` broadcast — looking it up here avoids a second roundtrip.
 */
export async function updateThreadTitle(
  db: AnyDb,
  threadId: string,
  title: string,
): Promise<{ userId: string; title: string; updatedAt: string } | null> {
  const [row] = await db
    .update(threads)
    .set({ title })
    .where(and(eq(threads.id, threadId), isNull(threads.deletedAt)))
    .returning();
  if (!row) return null;
  return { userId: row.userId, title: row.title, updatedAt: row.updatedAt.toISOString() };
}

/**
 * Title-generation precondition: thread still carries the default title AND
 * we've only persisted one user+assistant pair so far. Returning both pieces
 * (title + first user message) in one query keeps the chat domain's done-
 * branch tight — we read once, branch, then either fire the RPC or no-op.
 */
export async function getFirstTurnIfDefaultTitle(
  db: AnyDb,
  threadId: string,
): Promise<{ firstUserMessage: string } | null> {
  const t = await db
    .select({ title: threads.title })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);
  if (!t[0] || t[0].title !== "New chat") return null;
  const msgs = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt));
  // Expect exactly one user + one assistant (the one we just persisted).
  // More than two ⇒ we missed the first-turn window (e.g. retry on a long-
  // running thread). Bail rather than retitle something with history.
  if (msgs.length !== 2) return null;
  const userMsg = msgs.find((m) => m.role === "user");
  if (!userMsg) return null;
  return { firstUserMessage: userMsg.content };
}

// ─── SP-4 orchestrator thread helpers ────────────────────────────────────────

/** Returns the thread's `kind` ('chat' | 'workspace'), or null if it doesn't exist. */
export async function getThreadKind(db: AnyDb, threadId: string): Promise<string | null> {
  const [row] = await db
    .select({ kind: threads.kind })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1);
  return row?.kind ?? null;
}

/**
 * Workspace-level orchestrator thread — one per user, not referenced by any
 * project. Idempotent: reuses the existing (non-deleted) workspace thread for
 * the user, otherwise creates one with kind='workspace'.
 */
export async function getOrCreateWorkspaceThread(
  db: AnyDb,
  input: { userId: string; tenantId: string },
): Promise<{ id: string }> {
  const [existing] = await db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.userId, input.userId),
        eq(threads.kind, "workspace"),
        isNull(threads.deletedAt),
      ),
    )
    .limit(1);
  if (existing) return { id: existing.id };
  const [row] = await db
    .insert(threads)
    .values({
      userId: input.userId,
      tenantId: input.tenantId,
      title: "Workspace",
      kind: "workspace",
    })
    .returning();
  return { id: row!.id };
}

/**
 * Project-scoped orchestrator thread. Reuses `projects.thread_id` if set;
 * otherwise lazily creates a kind='workspace' thread and back-links it on the
 * project row so subsequent calls return the same thread. Also stamps
 * `threads.project_id` so scope detection (`getProjectByThreadId`) works off the
 * new multi-session column.
 */
export async function getOrCreateProjectThread(
  db: AnyDb,
  project: { id: string; userId: string; tenantId: string; threadId: string | null },
): Promise<{ id: string }> {
  if (project.threadId) return { id: project.threadId };
  const [row] = await db
    .insert(threads)
    .values({
      userId: project.userId,
      tenantId: project.tenantId,
      title: "Project chat",
      kind: "workspace",
      projectId: project.id,
    })
    .returning();
  await db.update(projects).set({ threadId: row!.id }).where(eq(projects.id, project.id));
  return { id: row!.id };
}

/**
 * List the orchestrator chat sessions for one scope, newest first.
 *   - workspace scope (projectId omitted): the user's kind='workspace' threads
 *     NOT bound to any project (cross-project orchestration).
 *   - project scope: every (non-deleted) thread stamped with this projectId.
 *
 * Backs the floating chat bubble's session list. Returns the same
 * `ThreadSummary` shape as `listThreads` so the UI reuses its row renderer.
 */
export async function listOrchestratorThreads(
  db: AnyDb,
  input: { userId: string; projectId?: string },
): Promise<ThreadSummary[]> {
  const where = input.projectId
    ? and(eq(threads.projectId, input.projectId), isNull(threads.deletedAt))
    : and(
        eq(threads.userId, input.userId),
        eq(threads.kind, "workspace"),
        isNull(threads.projectId),
        isNull(threads.deletedAt),
      );
  const rows = await db.select().from(threads).where(where).orderBy(desc(threads.updatedAt));
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() }));
}

/**
 * Open a fresh orchestrator session ("Start a new conversation" in the bubble).
 * kind='workspace' so sends route to `WorkspaceChatDomain`; project_id scopes it
 * (NULL ⇢ workspace-level). Title starts as "New conversation" and the client
 * renames it from the first user message.
 */
export async function createOrchestratorThread(
  db: AnyDb,
  input: { userId: string; tenantId: string; projectId?: string },
): Promise<ThreadSummary> {
  const [row] = await db
    .insert(threads)
    .values({
      userId: input.userId,
      tenantId: input.tenantId,
      title: "New conversation",
      kind: "workspace",
      projectId: input.projectId ?? null,
    })
    .returning();
  return { id: row!.id, title: row!.title, updatedAt: row!.updatedAt.toISOString() };
}

function toMessageView(r: typeof messages.$inferSelect): MessageView {
  return {
    id: r.id,
    threadId: r.threadId,
    role: r.role as Role,
    content: r.content,
    createdAt: r.createdAt.toISOString(),
    // Only surface `attachments` when the row actually carried metadata, so
    // attachment-free messages stay shaped exactly as before.
    ...(r.attachmentsJson
      ? { attachments: r.attachmentsJson as { name: string; size: number }[] }
      : {}),
  };
}
