import { eq, and, desc, asc } from "drizzle-orm";
import { threads, messages } from "./schema.js";
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
    .where(eq(threads.userId, userId))
    .orderBy(desc(threads.updatedAt));
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() }));
}

export async function getThreadDetail(db: AnyDb, threadId: string): Promise<ThreadDetail | null> {
  const t = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
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
    .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
    .limit(1);
  return rows.length > 0;
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

function toMessageView(r: typeof messages.$inferSelect): MessageView {
  return {
    id: r.id,
    threadId: r.threadId,
    role: r.role as Role,
    content: r.content,
    createdAt: r.createdAt.toISOString(),
  };
}
