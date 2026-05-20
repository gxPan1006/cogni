import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./test-db.js";
import { messages } from "./schema.js";
import { findOrCreateUserByEmail } from "./users.js";
import { createThread, listThreads, getThreadDetail, appendMessage, touchThread, threadBelongsToUser, updateThreadTitle, softDeleteThread } from "./threads.js";

describe("thread repository", () => {
  it("creates, lists, appends messages, and reads back detail", async () => {
    const { db, close } = await makeTestDb();
    const user = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: user.id, tenantId: user.tenantId });
    expect(thread.title).toBe("New chat");

    await appendMessage(db, { threadId: thread.id, role: "user", content: "hello" });
    await appendMessage(db, { threadId: thread.id, role: "assistant", content: "hi there" });

    const detail = await getThreadDetail(db, thread.id);
    expect(detail?.messages.map((m) => m.content)).toEqual(["hello", "hi there"]);

    const list = await listThreads(db, user.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(thread.id);
    await close();
  });

  it("touchThread bumps updatedAt for ordering", async () => {
    const { db, close } = await makeTestDb();
    const user = await findOrCreateUserByEmail(db, "b@x.com");
    const t1 = await createThread(db, { userId: user.id, tenantId: user.tenantId });
    await createThread(db, { userId: user.id, tenantId: user.tenantId });
    await new Promise((r) => setTimeout(r, 2)); // ensure t1's updatedAt is strictly later than t2's
    await touchThread(db, t1.id);
    const list = await listThreads(db, user.id);
    expect(list[0]?.id).toBe(t1.id); // most-recently-touched first
    await close();
  });

  it("getThreadDetail returns null for an unknown thread id", async () => {
    const { db, close } = await makeTestDb();
    const missing = await getThreadDetail(db, "00000000-0000-0000-0000-000000000000");
    expect(missing).toBeNull();
    await close();
  });

  it("threadBelongsToUser is true only for the owner", async () => {
    const { db, close } = await makeTestDb();
    const owner = await findOrCreateUserByEmail(db, "owner@x.com");
    const other = await findOrCreateUserByEmail(db, "other@x.com");
    const thread = await createThread(db, { userId: owner.id, tenantId: owner.tenantId });
    expect(await threadBelongsToUser(db, thread.id, owner.id)).toBe(true);
    expect(await threadBelongsToUser(db, thread.id, other.id)).toBe(false);
    expect(await threadBelongsToUser(db, "00000000-0000-0000-0000-000000000000", owner.id)).toBe(false);
    await close();
  });

  it("softDeleteThread hides the thread from list / detail / ownership but keeps messages", async () => {
    const { db, close } = await makeTestDb();
    const user = await findOrCreateUserByEmail(db, "del@x.com");
    const keep = await createThread(db, { userId: user.id, tenantId: user.tenantId });
    const drop = await createThread(db, { userId: user.id, tenantId: user.tenantId });
    await appendMessage(db, { threadId: drop.id, role: "user", content: "history stays" });

    const removed = await softDeleteThread(db, drop.id);
    expect(removed?.userId).toBe(user.id);

    // Gone from the list + every per-thread lookup …
    const list = await listThreads(db, user.id);
    expect(list.map((t) => t.id)).toEqual([keep.id]);
    expect(await getThreadDetail(db, drop.id)).toBeNull();
    expect(await threadBelongsToUser(db, drop.id, user.id)).toBe(false);

    // … but the messages row is still there (FK history intact).
    const msgs = await db.select().from(messages).where(eq(messages.threadId, drop.id));
    expect(msgs).toHaveLength(1);

    // Re-deleting is a no-op (idempotent) and returns null.
    expect(await softDeleteThread(db, drop.id)).toBeNull();
    await close();
  });

  it("updateThreadTitle renames a live thread but refuses a deleted one", async () => {
    const { db, close } = await makeTestDb();
    const user = await findOrCreateUserByEmail(db, "ren@x.com");
    const thread = await createThread(db, { userId: user.id, tenantId: user.tenantId });

    const renamed = await updateThreadTitle(db, thread.id, "My renamed chat");
    expect(renamed?.title).toBe("My renamed chat");
    expect((await listThreads(db, user.id))[0]?.title).toBe("My renamed chat");

    await softDeleteThread(db, thread.id);
    expect(await updateThreadTitle(db, thread.id, "too late")).toBeNull();
    await close();
  });
});
