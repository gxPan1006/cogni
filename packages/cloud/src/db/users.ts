import { eq } from "drizzle-orm";
import { tenants, users } from "./schema.js";
import type { AnyDb } from "./client.js";

export type { AnyDb };
export interface AppUser { id: string; tenantId: string; email: string; }
export interface AppUserWithPassword extends AppUser { passwordHash: string | null; }

/**
 * Email-keyed user lookup. The single source of identity in cogni is the
 * email address: one email = one user, no matter which auth method delivered
 * it. Specific identities (google sub, dev marker) live in the
 * `user_identities` table and are recorded by callers via `upsertIdentity`.
 *
 * The lookup is case-insensitive — the email is lowercased before write/query
 * so that "Alice@Gmail.com" and "alice@gmail.com" map to the same row.
 */
export async function findOrCreateUserByEmail(
  db: AnyDb, email: string,
): Promise<AppUser> {
  const lowered = email.toLowerCase();
  const existing = await db.select().from(users).where(eq(users.email, lowered)).limit(1);
  if (existing[0]) {
    return { id: existing[0].id, tenantId: existing[0].tenantId, email: existing[0].email };
  }
  // SP-1: one tenant per user. SP-2 will introduce org/tenant membership.
  const [tenant] = await db.insert(tenants).values({ name: lowered }).returning();
  const [created] = await db
    .insert(users)
    .values({ tenantId: tenant!.id, email: lowered })
    .returning();
  return { id: created!.id, tenantId: created!.tenantId, email: created!.email };
}

/**
 * Read-only, case-insensitive lookup by email. Returns null when no user has
 * that email. Includes `passwordHash` so password-login can verify in one
 * query. Does NOT create — used by the password login / reset paths where a
 * miss must look identical to a wrong password (anti-enumeration).
 */
export async function findUserByEmail(
  db: AnyDb, email: string,
): Promise<AppUserWithPassword | null> {
  const lowered = email.toLowerCase();
  const rows = await db.select().from(users).where(eq(users.email, lowered)).limit(1);
  const u = rows[0];
  if (!u) return null;
  return { id: u.id, tenantId: u.tenantId, email: u.email, passwordHash: u.passwordHash };
}

/** Set (or overwrite) a user's password hash. */
export async function setUserPassword(
  db: AnyDb, userId: string, passwordHash: string,
): Promise<void> {
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
}
