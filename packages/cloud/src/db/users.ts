import { eq } from "drizzle-orm";
import { tenants, users } from "./schema.js";
import type { AnyDb } from "./client.js";

export type { AnyDb };
export interface AppUser { id: string; tenantId: string; email: string; }

export async function findOrCreateUser(
  db: AnyDb,
  input: { oauthSub: string; email: string },
): Promise<AppUser> {
  const existing = await db.select().from(users).where(eq(users.oauthSub, input.oauthSub)).limit(1);
  if (existing[0]) {
    return { id: existing[0].id, tenantId: existing[0].tenantId, email: existing[0].email };
  }
  // SP-1: one tenant per user. SP-2 will introduce real org/tenant membership.
  const [tenant] = await db.insert(tenants).values({ name: input.email }).returning();
  const [created] = await db
    .insert(users)
    .values({ tenantId: tenant!.id, email: input.email, oauthSub: input.oauthSub })
    .returning();
  return { id: created!.id, tenantId: created!.tenantId, email: created!.email };
}
