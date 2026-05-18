import { eq, and } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { tenants, users, userIdentities } from "../db/schema.js";

/**
 * Unified login resolution: given a verified (kind, sub, email) triple from any
 * provider (Google OAuth or email magic-link), return the matching userId.
 *
 * Resolution order:
 *   1. exact (kind, sub) match — canonical path, regardless of email
 *   2. email match → attach this identity to the existing user (auto-merge)
 *   3. brand new user
 *
 * "Verified email" is a precondition: Google's id_token email is verified by
 * Google; magic-link's email is verified by the click. Anything else MUST NOT
 * call this helper.
 */
export async function findOrLinkUser(
  db: AnyDb,
  input: { kind: string; sub: string; email: string },
): Promise<{ userId: string; tenantId: string }> {
  // 1. exact identity match
  const idents = await db
    .select()
    .from(userIdentities)
    .where(and(eq(userIdentities.kind, input.kind), eq(userIdentities.sub, input.sub)))
    .limit(1);
  if (idents[0]) {
    const u = await db.select().from(users).where(eq(users.id, idents[0].userId)).limit(1);
    if (u[0]) return { userId: u[0].id, tenantId: u[0].tenantId };
  }

  const lowered = input.email.toLowerCase();

  // 2. email match — attach new identity to existing user
  const existing = await db.select().from(users).where(eq(users.email, lowered)).limit(1);
  if (existing[0]) {
    await db.insert(userIdentities)
      .values({ userId: existing[0].id, kind: input.kind, sub: input.sub })
      .onConflictDoNothing();
    return { userId: existing[0].id, tenantId: existing[0].tenantId };
  }

  // 3. brand new user
  const [tenant] = await db.insert(tenants).values({ name: lowered }).returning();
  const [created] = await db.insert(users).values({ tenantId: tenant!.id, email: lowered }).returning();
  await db.insert(userIdentities)
    .values({ userId: created!.id, kind: input.kind, sub: input.sub })
    .onConflictDoNothing();
  return { userId: created!.id, tenantId: created!.tenantId };
}
