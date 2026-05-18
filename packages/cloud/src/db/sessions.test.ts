import { describe, it, expect } from "vitest";
import { makeTestDb } from "./test-db.js";
import { findOrCreateUserByEmail } from "./users.js";
import { createThread } from "./threads.js";
import {
  getOrCreateRunnerSession, getRunnerSessionById, setRunnerSessionId, setRunnerSessionStatus,
  appendEvent, listEventsSince,
} from "./sessions.js";

describe("session + event repository", () => {
  it("reuses one runner_session per thread", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const s1 = await getOrCreateRunnerSession(db, thread.id, "claude-code");
    const s2 = await getOrCreateRunnerSession(db, thread.id, "claude-code");
    expect(s1.id).toBe(s2.id);
    await close();
  });

  it("assigns monotonic per-thread seq and lists events since N", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const s = await getOrCreateRunnerSession(db, thread.id, "claude-code");
    const e1 = await appendEvent(db, { threadId: thread.id, sessionId: s.id, event: { type: "text", text: "a" } });
    const e2 = await appendEvent(db, { threadId: thread.id, sessionId: s.id, event: { type: "text", text: "b" } });
    expect([e1.seq, e2.seq]).toEqual([1, 2]);
    const since = await listEventsSince(db, thread.id, 1);
    expect(since.map((e) => e.seq)).toEqual([2]);
    await close();
  });

  it("getRunnerSessionById returns null for an unknown id", async () => {
    const { db, close } = await makeTestDb();
    const missing = await getRunnerSessionById(db, "00000000-0000-0000-0000-000000000000");
    expect(missing).toBeNull();
    await close();
  });

  it("tracks runnerSessionId and status", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const s = await getOrCreateRunnerSession(db, thread.id, "claude-code");
    await setRunnerSessionId(db, s.id, "claude-xyz");
    await setRunnerSessionStatus(db, s.id, "running");
    const again = await getOrCreateRunnerSession(db, thread.id, "claude-code");
    expect(again.runnerSessionId).toBe("claude-xyz");
    expect(again.status).toBe("running");
    const byId = await getRunnerSessionById(db, s.id);
    expect(byId?.threadId).toBe(thread.id);
    await close();
  });
});
