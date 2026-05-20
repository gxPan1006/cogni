import { describe, it, expect, vi } from "vitest";
import { makeTestDb } from "../db/test-db.js";
import { findOrCreateUserByEmail } from "../db/users.js";
import { createHost } from "../db/hosts.js";
import { createThread } from "../db/threads.js";
import { getThreadDetail } from "../db/threads.js";
import { openRunnerSession, getCurrentActiveSession } from "../db/sessions.js";
import { HostRouter } from "../host-router.js";
import { ClientHub } from "../client-hub.js";
import { ChatDomain } from "./chat.js";

describe("ChatDomain (SP-2 state machine)", () => {
  it("no-host-online: replies to source conn + does NOT persist message + no runner_session", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const hub = new ClientHub();
    const send = vi.fn();
    hub.register({ clientId: "c1", userId: u.id, send });
    const chat = new ChatDomain(db, new HostRouter(), hub);

    await chat.handleClientSend({
      userId: u.id, threadId: thread.id, content: "hello", sourceClientId: "c1",
    });

    // Source conn receives no-host-online with a fresh pendingMessageId
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      t: "no-host-online", pendingMessageId: expect.any(String),
    }));
    // Message NOT persisted (pre-dispatch state only in client UI)
    const detail = await getThreadDetail(db, thread.id);
    expect(detail?.messages).toEqual([]);
    // No runner_session opened
    expect(await getCurrentActiveSession(db, thread.id)).toBeNull();
    await close();
  });

  it("preferred online (or new thread): persists user msg, opens session, dispatches", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const reg = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Mac" });
    const hub = new ClientHub();
    const clientSend = vi.fn();
    hub.register({ clientId: "c1", userId: u.id, send: clientSend });
    hub.subscribe("c1", thread.id);
    const router = new HostRouter();
    const hostSend = vi.fn();
    router.register({ hostId: reg.hostId, userId: u.id, send: hostSend });
    const chat = new ChatDomain(db, router, hub);

    await chat.handleClientSend({
      userId: u.id, threadId: thread.id, content: "hi", sourceClientId: "c1",
    });

    const dispatch = hostSend.mock.calls[0]![0];
    expect(dispatch).toMatchObject({ t: "dispatch", threadId: thread.id, runnerSessionId: null, message: "hi" });
    const sessionId = dispatch.sessionId;
    const active = await getCurrentActiveSession(db, thread.id);
    expect(active?.id).toBe(sessionId);
    expect(active?.hostId).toBe(reg.hostId);

    await chat.handleHostEvent(sessionId, { type: "session-id", id: "claude-1" });
    await chat.handleHostEvent(sessionId, { type: "text", text: "hello back" });
    await chat.handleHostEvent(sessionId, { type: "done" });

    const detail = await getThreadDetail(db, thread.id);
    expect(detail?.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:hi",
      "assistant:hello back",
    ]);
    const eventMsgs = clientSend.mock.calls.map((c) => c[0]).filter((m) => m.t === "event");
    expect(eventMsgs.map((m) => m.seq)).toEqual([1, 2, 3]);

    // second turn on same host: reuses the session (runner_session_id now set)
    await chat.handleClientSend({
      userId: u.id, threadId: thread.id, content: "again", sourceClientId: "c1",
    });
    expect(hostSend.mock.calls[1]![0]).toMatchObject({ runnerSessionId: "claude-1", message: "again" });
    await close();
  });

  it("preferred offline + alternative online: emits host-fallback-prompt; no persist yet", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const hostA = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Home" });
    const hostB = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Work" });
    // Seed a prior session on hostA so it becomes "preferred"
    await openRunnerSession(db, { threadId: thread.id, hostId: hostA.hostId, adapter: "claude-code" });

    const hub = new ClientHub();
    const send = vi.fn();
    hub.register({ clientId: "c1", userId: u.id, send });
    const router = new HostRouter();
    // Only hostB is online — hostA's preferred but offline.
    router.register({ hostId: hostB.hostId, userId: u.id, send: () => {} });
    const chat = new ChatDomain(db, router, hub);

    await chat.handleClientSend({
      userId: u.id, threadId: thread.id, content: "switch me", sourceClientId: "c1",
    });

    const promptCall = send.mock.calls.find((c) => c[0]?.t === "host-fallback-prompt");
    expect(promptCall).toBeDefined();
    const prompt = promptCall![0];
    expect(prompt.preferred.id).toBe(hostA.hostId);
    expect(prompt.alternatives.map((a: { id: string }) => a.id)).toEqual([hostB.hostId]);

    // Not persisted yet
    const detail = await getThreadDetail(db, thread.id);
    expect(detail?.messages).toEqual([]);
    await close();
  });

  it("resolve-fallback switch: closes old session, opens new on target host, persists + dispatches", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const hostA = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Home" });
    const hostB = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Work" });
    const oldSession = await openRunnerSession(db, { threadId: thread.id, hostId: hostA.hostId, adapter: "claude-code" });

    const hub = new ClientHub();
    const send = vi.fn();
    hub.register({ clientId: "c1", userId: u.id, send });
    const router = new HostRouter();
    const hostBSend = vi.fn();
    router.register({ hostId: hostB.hostId, userId: u.id, send: hostBSend });
    const chat = new ChatDomain(db, router, hub);

    await chat.handleClientSend({
      userId: u.id, threadId: thread.id, content: "queued", sourceClientId: "c1",
    });
    const prompt = send.mock.calls.find((c) => c[0]?.t === "host-fallback-prompt")![0];

    await chat.handleResolveFallback({
      userId: u.id, pendingMessageId: prompt.pendingMessageId,
      action: "switch", targetHostId: hostB.hostId, sourceClientId: "c1",
    });

    // Old session marked closed
    const { getRunnerSessionById } = await import("../db/sessions.js");
    const old = await getRunnerSessionById(db, oldSession.id);
    expect(old?.status).toBe("closed");
    // New session on hostB, running
    const active = await getCurrentActiveSession(db, thread.id);
    expect(active?.hostId).toBe(hostB.hostId);
    expect(active?.status).toBe("running");
    // Dispatched to hostB
    expect(hostBSend).toHaveBeenCalledWith(expect.objectContaining({ t: "dispatch", message: "queued" }));
    // Message persisted (now that switch happened)
    const detail = await getThreadDetail(db, thread.id);
    expect(detail?.messages.map((m) => m.content)).toEqual(["queued"]);
    await close();
  });

  it("resolve-fallback cancel: no persist, drops pending", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const hostA = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Home" });
    const hostB = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Work" });
    await openRunnerSession(db, { threadId: thread.id, hostId: hostA.hostId, adapter: "claude-code" });

    const hub = new ClientHub();
    const send = vi.fn();
    hub.register({ clientId: "c1", userId: u.id, send });
    const router = new HostRouter();
    router.register({ hostId: hostB.hostId, userId: u.id, send: () => {} });
    const chat = new ChatDomain(db, router, hub);

    await chat.handleClientSend({
      userId: u.id, threadId: thread.id, content: "discard me", sourceClientId: "c1",
    });
    const prompt = send.mock.calls.find((c) => c[0]?.t === "host-fallback-prompt")![0];

    await chat.handleResolveFallback({
      userId: u.id, pendingMessageId: prompt.pendingMessageId,
      action: "cancel", targetHostId: null, sourceClientId: "c1",
    });

    const detail = await getThreadDetail(db, thread.id);
    expect(detail?.messages).toEqual([]);
    await close();
  });

  it("resolve-fallback with unknown pendingMessageId is a silent no-op", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const chat = new ChatDomain(db, new HostRouter(), new ClientHub());
    await expect(chat.handleResolveFallback({
      userId: u.id, pendingMessageId: "nonexistent",
      action: "switch", targetHostId: "anywhere", sourceClientId: "c1",
    })).resolves.toBeUndefined();
    await close();
  });

  it("marks the session failed and notifies host-status:false when host.send throws", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const reg = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Mac" });
    const hub = new ClientHub();
    const clientSend = vi.fn();
    hub.register({ clientId: "c1", userId: u.id, send: clientSend });
    const router = new HostRouter();
    router.register({ hostId: reg.hostId, userId: u.id, send: () => { throw new Error("socket dead"); } });
    const chat = new ChatDomain(db, router, hub);

    await chat.handleClientSend({
      userId: u.id, threadId: thread.id, content: "hi", sourceClientId: "c1",
    });

    expect(clientSend).toHaveBeenCalledWith(expect.objectContaining({ t: "host-status", online: false }));
    const active = await getCurrentActiveSession(db, thread.id);
    expect(active?.status).toBe("failed");
    await close();
  });

  it("prepends an attachment preamble and forwards attachments on dispatch", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const reg = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Mac" });
    const hub = new ClientHub();
    const clientSend = vi.fn();
    hub.register({ clientId: "c1", userId: u.id, send: clientSend });
    hub.subscribe("c1", thread.id);
    const router = new HostRouter();
    const hostSend = vi.fn();
    router.register({ hostId: reg.hostId, userId: u.id, send: hostSend });
    const chat = new ChatDomain(db, router, hub);

    await chat.handleClientSend({
      userId: u.id, threadId: thread.id, content: "summarize this", sourceClientId: "c1",
      attachments: [{ name: "report.pdf", size: 100 }],
    });

    const dispatch = hostSend.mock.calls.map((c) => c[0]).find((m) => m.t === "dispatch");
    expect(dispatch.attachments).toEqual([{ name: "report.pdf", size: 100 }]);
    expect(dispatch.message).toContain(".cogni-uploads/report.pdf");
    expect(dispatch.message).toContain("summarize this");
    await close();
  });

  it("persists attachments on the user message and broadcasts them", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const reg = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Mac" });
    const hub = new ClientHub();
    const clientSend = vi.fn();
    hub.register({ clientId: "c1", userId: u.id, send: clientSend });
    hub.subscribe("c1", thread.id);
    const router = new HostRouter();
    router.register({ hostId: reg.hostId, userId: u.id, send: vi.fn() });
    const chat = new ChatDomain(db, router, hub);

    await chat.handleClientSend({
      userId: u.id, threadId: thread.id, content: "see file", sourceClientId: "c1",
      attachments: [{ name: "a.png", size: 10 }],
    });

    const msgFrame = clientSend.mock.calls
      .map((c) => c[0])
      .find((m) => m.t === "message" && m.role === "user");
    expect(msgFrame.attachments).toEqual([{ name: "a.png", size: 10 }]);
    await close();
  });

  it("handleSessionUpdate persists the session status", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const host = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Mac" });
    const session = await openRunnerSession(db, { threadId: thread.id, hostId: host.hostId, adapter: "claude-code" });
    const chat = new ChatDomain(db, new HostRouter(), new ClientHub());
    await chat.handleSessionUpdate(session.id, "failed");
    const { getRunnerSessionById } = await import("../db/sessions.js");
    const after = await getRunnerSessionById(db, session.id);
    expect(after?.status).toBe("failed");
    await close();
  });

  it("prewarm: opens a session (without marking running) + sends a prewarm frame to the host", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const reg = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Mac" });
    const router = new HostRouter();
    const hostSend = vi.fn();
    router.register({ hostId: reg.hostId, userId: u.id, send: hostSend });
    const chat = new ChatDomain(db, router, new ClientHub());

    await chat.handleClientPrewarm({ userId: u.id, threadId: thread.id, model: "claude-x" });

    const frame = hostSend.mock.calls[0]![0];
    expect(frame).toMatchObject({ t: "prewarm", threadId: thread.id, runnerSessionId: null, model: "claude-x" });
    // a session now exists for the thread, and the later send reuses that same id
    const active = await getCurrentActiveSession(db, thread.id);
    expect(active?.id).toBe(frame.sessionId);
    expect(active?.status).not.toBe("running"); // prewarm must not show "thinking"
    await close();
  });

  it("prewarm then send reuse the SAME sessionId (so the warm process is the one used)", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const reg = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Mac" });
    const router = new HostRouter();
    const hostSend = vi.fn();
    router.register({ hostId: reg.hostId, userId: u.id, send: hostSend });
    const chat = new ChatDomain(db, router, new ClientHub());

    await chat.handleClientPrewarm({ userId: u.id, threadId: thread.id });
    await chat.handleClientSend({ userId: u.id, threadId: thread.id, content: "hi", sourceClientId: "c1" });

    const prewarm = hostSend.mock.calls.find((c) => c[0]?.t === "prewarm")![0];
    const dispatch = hostSend.mock.calls.find((c) => c[0]?.t === "dispatch")![0];
    expect(dispatch.sessionId).toBe(prewarm.sessionId);
    await close();
  });

  it("prewarm: no online host → no frame, no session opened", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Mac" }); // registered but offline
    const router = new HostRouter(); // no host connected
    const chat = new ChatDomain(db, router, new ClientHub());

    await chat.handleClientPrewarm({ userId: u.id, threadId: thread.id });

    expect(await getCurrentActiveSession(db, thread.id)).toBeNull();
    await close();
  });
});
