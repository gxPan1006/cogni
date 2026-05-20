import { eq, isNull, and } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { hosts } from "./schema.js";
import type { AnyDb } from "./users.js";
import type { HostRegistration } from "@cogni/contract";

export async function createHost(
  db: AnyDb,
  input: { userId: string; tenantId: string; name: string },
): Promise<HostRegistration> {
  const registrationToken = randomBytes(32).toString("hex");
  const [row] = await db
    .insert(hosts)
    .values({ userId: input.userId, tenantId: input.tenantId, name: input.name, registrationToken })
    .returning();
  return { hostId: row!.id, registrationToken };
}

export async function findHostByToken(db: AnyDb, token: string) {
  const rows = await db
    .select()
    .from(hosts)
    .where(and(eq(hosts.registrationToken, token), isNull(hosts.removedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function setHostStatus(
  db: AnyDb,
  hostId: string,
  status: "online" | "offline",
  capabilities?: string[],
): Promise<void> {
  const patch: Partial<typeof hosts.$inferInsert> = { status, lastSeen: new Date() };
  if (capabilities !== undefined) patch.capabilitiesJson = capabilities;
  await db.update(hosts).set(patch).where(eq(hosts.id, hostId));
}

export async function getUserHosts(db: AnyDb, userId: string) {
  return db.select().from(hosts).where(eq(hosts.userId, userId));
}

export async function renameHost(db: AnyDb, hostId: string, name: string): Promise<void> {
  await db.update(hosts).set({ name }).where(eq(hosts.id, hostId));
}

export async function softRemoveHost(db: AnyDb, hostId: string): Promise<void> {
  await db
    .update(hosts)
    .set({ removedAt: new Date(), status: "offline" })
    .where(eq(hosts.id, hostId));
}

export async function isHostRemoved(db: AnyDb, hostId: string): Promise<boolean> {
  const rows = await db
    .select({ removedAt: hosts.removedAt })
    .from(hosts)
    .where(eq(hosts.id, hostId))
    .limit(1);
  return rows[0] ? rows[0].removedAt !== null : false;
}

/**
 * SP-4: persist a host's resolved projects-root (and whether it's env-locked).
 * Written on the `register` frame and by PUT /api/hosts/:id/projects-root.
 */
export async function setHostProjectsRoot(
  db: AnyDb,
  hostId: string,
  projectsRoot: string,
  locked: boolean,
): Promise<void> {
  await db
    .update(hosts)
    .set({ projectsRoot, projectsRootLocked: locked })
    .where(eq(hosts.id, hostId));
}

export async function getActiveHostsForUser(db: AnyDb, userId: string) {
  return db
    .select()
    .from(hosts)
    .where(and(eq(hosts.userId, userId), isNull(hosts.removedAt)));
}
