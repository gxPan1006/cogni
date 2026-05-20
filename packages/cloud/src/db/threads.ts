import { eq, and, desc, asc, isNull } from "drizzle-orm";
import { threads, messages, projects } from "./schema.js";
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
  const rows = await db
    .select()
    .from(threads)
    .where(and(eq(threads.userId, userId), isNull(threads.deletedAt)))
    .orderBy(desc(threads.updatedAt));
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() }));
}

export async function getThreadDetail(db: AnyDb, threadId: string): Promise<ThreadDetail | null> {
  const t = await db
    .select()
    .from(threads)
    .where(and(eq(threads.id, threadId), isNull(threads.deletedAt)))
    .limit(1);
  if (!t[0]) return null;
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt));
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
  input: { threadId: string; role: Role; content: string },
): Promise<MessageView> {
  const [row] = await db
    .insert(messages)
    .values({ threadId: input.threadId, role: input.role, content: input.content })
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
 * project row so subsequent calls return the same thread.
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
    })
    .returning();
  await db.update(projects).set({ threadId: row!.id }).where(eq(projects.id, project.id));
  return { id: row!.id };
}

function toMessageView(r: typeof messages.$inferSelect): MessageView {
  return {
    id: r.id,
    threadId: r.threadId,
    role: r.role as Role,
    content: r.content,
    createdAt: r.createdAt.toISOString(),
  };
}
