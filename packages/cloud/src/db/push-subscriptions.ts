import { eq } from "drizzle-orm";
import { pushSubscriptions } from "./schema.js";
import type { AnyDb } from "./client.js";

export interface PushSubscriptionRow {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  locale: string;
  userAgent: string | null;
  createdAt: Date;
}

/**
 * Upsert by endpoint: a browser that re-subscribes (or a different login on the
 * same browser) returns the same endpoint, so we key on it and refresh the
 * keys / owner instead of inserting duplicates.
 */
export async function upsertPushSubscription(
  db: AnyDb,
  input: {
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    locale?: string;
    userAgent?: string | null;
  },
): Promise<void> {
  await db
    .insert(pushSubscriptions)
    .values({
      userId: input.userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      locale: input.locale ?? "en",
      userAgent: input.userAgent ?? null,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId: input.userId,
        p256dh: input.p256dh,
        auth: input.auth,
        locale: input.locale ?? "en",
        userAgent: input.userAgent ?? null,
      },
    });
}

export async function listPushSubscriptionsForUser(
  db: AnyDb,
  userId: string,
): Promise<PushSubscriptionRow[]> {
  const rows = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
  return rows.map(toRow);
}

/** Remove a dead endpoint (push service returned 404/410) or on user unsubscribe. */
export async function deletePushSubscriptionByEndpoint(db: AnyDb, endpoint: string): Promise<void> {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
}

function toRow(r: typeof pushSubscriptions.$inferSelect): PushSubscriptionRow {
  return {
    id: r.id,
    userId: r.userId,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    locale: r.locale,
    userAgent: r.userAgent,
    createdAt: r.createdAt,
  };
}
