import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./test-db.js";
import { findOrCreateUserByEmail } from "./users.js";
import { createThread } from "./threads.js";
import { createHost } from "./hosts.js";
import { runnerSessions } from "./schema.js";
import {
  getOrCreateRunnerSession, getRunnerSessionById, setRunnerSessionId, setRunnerSessionStatus,
  appendEvent, listEventsSince,
  openRunnerSession, getCurrentActiveSession, closeRunnerSession, getLatestSessionForThread,
} from "./sessions.js";

async function seedThreadAndHost() {
  const { db, close } = await makeTestDb();
  const u = await findOrCreateUserByEmail(db, "seed@x.com");
  const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
  const reg = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "host-1" });
  return { db, close, thread, host: { id: reg.hostId } };
}

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

  it("openRunnerSession creates a fresh row with hostId + adapter", async () => {
    const { db, close, thread, host } = await seedThreadAndHost();
    const s = await openRunnerSession(db, { threadId: thread.id, hostId: host.id, adapter: "claude-code" });
    expect(s.threadId).toBe(thread.id);
    expect(s.hostId).toBe(host.id);
    expect(s.status).toBe("idle");
    await close();
  });

  it("getCurrentActiveSession returns the most recent non-closed session", async () => {
    const { db, close, thread, host } = await seedThreadAndHost();
    const s1 = await openRunnerSession(db, { threadId: thread.id, hostId: host.id, adapter: "claude-code" });
    await closeRunnerSession(db, s1.id);
    const s2 = await openRunnerSession(db, { threadId: thread.id, hostId: host.id, adapter: "claude-code" });
    const active = await getCurrentActiveSession(db, thread.id);
    expect(active?.id).toBe(s2.id);
    await close();
  });

  it("getCurrentActiveSession returns null when only closed sessions exist", async () => {
    const { db, close, thread, host } = await seedThreadAndHost();
    const s = await openRunnerSession(db, { threadId: thread.id, hostId: host.id, adapter: "claude-code" });
    await closeRunnerSession(db, s.id);
    expect(await getCurrentActiveSession(db, thread.id)).toBeNull();
    await close();
  });

  it("closeRunnerSession sets status=closed + closed_at", async () => {
    const { db, close, thread, host } = await seedThreadAndHost();
    const s = await openRunnerSession(db, { threadId: thread.id, hostId: host.id, adapter: "claude-code" });
    await closeRunnerSession(db, s.id);
    const rows = await db.select().from(runnerSessions).where(eq(runnerSessions.id, s.id));
    expect(rows[0]!.status).toBe("closed");
    expect(rows[0]!.closedAt).not.toBeNull();
    await close();
  });

  it("getLatestSessionForThread returns most recent regardless of closed status", async () => {
    const { db, close, thread, host } = await seedThreadAndHost();
    const s1 = await openRunnerSession(db, { threadId: thread.id, hostId: host.id, adapter: "claude-code" });
    await closeRunnerSession(db, s1.id);
    const latest = await getLatestSessionForThread(db, thread.id);
    expect(latest?.id).toBe(s1.id);
    expect(latest?.status).toBe("closed");
    await close();
  });
});
