import { eq } from "drizzle-orm";
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
  const rows = await db.select().from(hosts).where(eq(hosts.registrationToken, token)).limit(1);
  return rows[0] ?? null;
}

export async function setHostStatus(
  db: AnyDb,
  hostId: string,
  status: "online" | "offline",
  capabilities: string[] = [],
): Promise<void> {
  await db
    .update(hosts)
    .set({ status, capabilitiesJson: capabilities, lastSeen: new Date() })
    .where(eq(hosts.id, hostId));
}

export async function getUserHosts(db: AnyDb, userId: string) {
  return db.select().from(hosts).where(eq(hosts.userId, userId));
}
