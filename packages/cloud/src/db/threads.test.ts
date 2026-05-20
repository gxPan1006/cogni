import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./test-db.js";
import { messages } from "./schema.js";
import { findOrCreateUserByEmail } from "./users.js";
import { createThread, listThreads, getThreadDetail, appendMessage, touchThread, threadBelongsToUser, updateThreadTitle, softDeleteThread, getOrCreateWorkspaceThread, getOrCreateProjectThread, getThreadKind } from "./threads.js";
import { createHost } from "./hosts.js";
import { createProject, getProject } from "./projects.js";

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

  it("listThreads excludes kind='workspace' orchestrator sessions", async () => {
    const { db, close } = await makeTestDb();
    const user = await findOrCreateUserByEmail(db, "ws@x.com");
    const chat = await createThread(db, { userId: user.id, tenantId: user.tenantId });
    await getOrCreateWorkspaceThread(db, { userId: user.id, tenantId: user.tenantId });
    const list = await listThreads(db, user.id);
    expect(list.map((t) => t.id)).toEqual([chat.id]); // only the ordinary chat
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

describe("appendMessage attachments", () => {
  it("stores and returns attachment metadata", async () => {
    const { db, close } = await makeTestDb();
    const user = await findOrCreateUserByEmail(db, "att@x.com");
    const thread = await createThread(db, { userId: user.id, tenantId: user.tenantId });
    const msg = await appendMessage(db, {
      threadId: thread.id,
      role: "user",
      content: "see file",
      attachments: [{ name: "a.pdf", size: 12 }],
    });
    expect(msg.attachments).toEqual([{ name: "a.pdf", size: 12 }]);
    const detail = await getThreadDetail(db, thread.id);
    expect(detail?.messages[0]?.attachments).toEqual([{ name: "a.pdf", size: 12 }]);
    await close();
  });

  it("omits attachments when none were provided", async () => {
    const { db, close } = await makeTestDb();
    const user = await findOrCreateUserByEmail(db, "noatt@x.com");
    const thread = await createThread(db, { userId: user.id, tenantId: user.tenantId });
    const msg = await appendMessage(db, { threadId: thread.id, role: "user", content: "hi" });
    expect(msg.attachments).toBeUndefined();
    const detail = await getThreadDetail(db, thread.id);
    expect(detail?.messages[0]?.attachments).toBeUndefined();
    await close();
  });
});

describe("SP-4 orchestrator thread helpers", () => {
  it("getOrCreateWorkspaceThread is idempotent per user and marks kind=workspace", async () => {
    const { db, close } = await makeTestDb();
    const user = await findOrCreateUserByEmail(db, "ws@x.com");
    const a = await getOrCreateWorkspaceThread(db, { userId: user.id, tenantId: user.tenantId });
    const b = await getOrCreateWorkspaceThread(db, { userId: user.id, tenantId: user.tenantId });
    expect(a.id).toBe(b.id);
    expect(await getThreadKind(db, a.id)).toBe("workspace");
    await close();
  });

  it("getThreadKind returns 'chat' for an ordinary thread and null for unknown", async () => {
    const { db, close } = await makeTestDb();
    const user = await findOrCreateUserByEmail(db, "kind@x.com");
    const thread = await createThread(db, { userId: user.id, tenantId: user.tenantId });
    expect(await getThreadKind(db, thread.id)).toBe("chat");
    expect(await getThreadKind(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
    await close();
  });

  it("getOrCreateProjectThread reuses projects.thread_id and lazily creates a workspace thread", async () => {
    const { db, close } = await makeTestDb();
    const user = await findOrCreateUserByEmail(db, "proj@x.com");
    const host = await createHost(db, { userId: user.id, tenantId: user.tenantId, name: "Mac" });
    const project = await createProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "P",
      repoPath: "/tmp/p",
      defaultHostId: host.hostId,
    });
    // First call creates + links a thread.
    const a = await getOrCreateProjectThread(db, {
      id: project.id,
      userId: user.id,
      tenantId: user.tenantId,
      threadId: project.threadId ?? null,
    });
    expect(await getThreadKind(db, a.id)).toBe("workspace");
    const linked = await getProject(db, project.id);
    expect(linked?.threadId).toBe(a.id);
    // Second call (now that thread_id is set) returns the same thread.
    const b = await getOrCreateProjectThread(db, {
      id: project.id,
      userId: user.id,
      tenantId: user.tenantId,
      threadId: linked!.threadId,
    });
    expect(b.id).toBe(a.id);
    await close();
  });
});
