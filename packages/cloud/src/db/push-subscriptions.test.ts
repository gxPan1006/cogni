import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "./test-db.js";
import { findOrCreateUserByEmail } from "./users.js";
import {
  upsertPushSubscription,
  listPushSubscriptionsForUser,
  deletePushSubscriptionByEndpoint,
} from "./push-subscriptions.js";

describe("push-subscriptions data layer", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let userId: string;

  beforeEach(async () => {
    ({ db, close } = await makeTestDb());
    const user = await findOrCreateUserByEmail(db, "push@example.com");
    userId = user.id;
  });
  afterEach(async () => {
    await close();
  });

  it("inserts and lists a subscription", async () => {
    await upsertPushSubscription(db, {
      userId,
      endpoint: "https://push.example/abc",
      p256dh: "key1",
      auth: "auth1",
      locale: "zh",
    });
    const rows = await listPushSubscriptionsForUser(db, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ endpoint: "https://push.example/abc", locale: "zh", p256dh: "key1" });
  });

  it("upserts by endpoint (no duplicate; refreshes keys + locale)", async () => {
    await upsertPushSubscription(db, { userId, endpoint: "https://push.example/abc", p256dh: "old", auth: "old", locale: "en" });
    await upsertPushSubscription(db, { userId, endpoint: "https://push.example/abc", p256dh: "new", auth: "new", locale: "zh" });
    const rows = await listPushSubscriptionsForUser(db, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ p256dh: "new", auth: "new", locale: "zh" });
  });

  it("defaults locale to 'en' when omitted", async () => {
    await upsertPushSubscription(db, { userId, endpoint: "https://push.example/x", p256dh: "k", auth: "a" });
    const rows = await listPushSubscriptionsForUser(db, userId);
    expect(rows[0]?.locale).toBe("en");
  });

  it("deletes by endpoint", async () => {
    await upsertPushSubscription(db, { userId, endpoint: "https://push.example/del", p256dh: "k", auth: "a" });
    await deletePushSubscriptionByEndpoint(db, "https://push.example/del");
    expect(await listPushSubscriptionsForUser(db, userId)).toHaveLength(0);
  });
});
