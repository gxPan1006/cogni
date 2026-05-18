import { eq, and, isNull, desc } from "drizzle-orm";
import { authSessions } from "./schema.js";
import type { AnyDb } from "./client.js";

export interface AuthSessionRow {
  id: string;
  userId: string;
  deviceName: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

export async function createAuthSession(
  db: AnyDb,
  input: { userId: string; deviceName: string; userAgent?: string; ip?: string },
): Promise<AuthSessionRow> {
  const [row] = await db
    .insert(authSessions)
    .values({
      userId: input.userId,
      deviceName: input.deviceName,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
    })
    .returning();
  return toRow(row!);
}

export async function getAuthSession(db: AnyDb, id: string): Promise<AuthSessionRow | null> {
  const rows = await db.select().from(authSessions).where(eq(authSessions.id, id)).limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function listAuthSessionsForUser(db: AnyDb, userId: string): Promise<AuthSessionRow[]> {
  const rows = await db
    .select()
    .from(authSessions)
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
    .orderBy(desc(authSessions.lastSeenAt));
  return rows.map(toRow);
}

export async function revokeAuthSession(db: AnyDb, id: string): Promise<void> {
  await db.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.id, id));
}

export async function touchAuthSession(db: AnyDb, id: string): Promise<void> {
  await db.update(authSessions).set({ lastSeenAt: new Date() }).where(eq(authSessions.id, id));
}

function toRow(r: typeof authSessions.$inferSelect): AuthSessionRow {
  return {
    id: r.id,
    userId: r.userId,
    deviceName: r.deviceName,
    userAgent: r.userAgent,
    ip: r.ip,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    revokedAt: r.revokedAt,
  };
}
