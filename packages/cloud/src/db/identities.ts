import { eq } from "drizzle-orm";
import { userIdentities } from "./schema.js";
import type { AnyDb } from "./client.js";

export interface UserIdentity {
  userId: string;
  kind: string;
  sub: string;
}

/**
 * Insert (userId, kind, sub) if not already present. Idempotent: a duplicate
 * (kind, sub) pair is silently ignored (ON CONFLICT DO NOTHING). The cross-user
 * uniqueness of (kind, sub) means two different users cannot claim the same
 * google sub or email — the second insert is a no-op, not a takeover.
 */
export async function upsertIdentity(
  db: AnyDb, userId: string, kind: string, sub: string,
): Promise<void> {
  await db.insert(userIdentities)
    .values({ userId, kind, sub })
    .onConflictDoNothing();
}

export async function listIdentitiesForUser(
  db: AnyDb, userId: string,
): Promise<UserIdentity[]> {
  const rows = await db.select().from(userIdentities).where(eq(userIdentities.userId, userId));
  return rows.map((r) => ({ userId: r.userId, kind: r.kind, sub: r.sub }));
}
