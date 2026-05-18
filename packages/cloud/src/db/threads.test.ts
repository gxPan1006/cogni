import { describe, it, expect } from "vitest";
import { makeTestDb } from "./test-db.js";
import { findOrCreateUserByEmail } from "./users.js";
import { createThread, listThreads, getThreadDetail, appendMessage, touchThread, threadBelongsToUser } from "./threads.js";

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
});
