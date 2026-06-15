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
import { THREAD_CLEARED_MARKER } from "@cogni/contract";

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

  it("uses the host default Claude snapshot adapter for new sessions", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "snapshot-chat@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const reg = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Mac" });
    const hub = new ClientHub();
    hub.register({ clientId: "c1", userId: u.id, send: vi.fn() });
    const router = new HostRouter();
    const hostSend = vi.fn();
    router.register({
      hostId: reg.hostId,
      userId: u.id,
      send: hostSend,
      adapters: ["claude-code", "claude-code-snapshot", "codex"],
      defaultAdapter: "claude-code-snapshot",
      adapterCommands: {
        "claude-code": ["clear", "branch"],
        "claude-code-snapshot": ["clear", "branch"],
        codex: ["clear"],
      },
    });
    const chat = new ChatDomain(db, router, hub);

    await chat.handleClientSend({
      userId: u.id, threadId: thread.id, content: "hi", sourceClientId: "c1",
    });

    expect(hostSend.mock.calls[0]![0]).toMatchObject({ adapter: "claude-code-snapshot" });
    const active = await getCurrentActiveSession(db, thread.id);
    expect(active?.adapter).toBe("claude-code-snapshot");
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

describe("ChatDomain — runner commands + stop", () => {
  async function setup() {
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
    router.register({
      hostId: reg.hostId, userId: u.id, send: hostSend,
      adapterCommands: { "claude-code": ["clear", "branch"] },
    });
    const chat = new ChatDomain(db, router, hub);
    return { db, close, u, thread, hub, clientSend, hostSend, chat, hostId: reg.hostId };
  }

  it("commandsForThread returns the online host's adapter commands (empty when offline)", async () => {
    const { db, close, u, thread, chat } = await setup();
    expect(await chat.commandsForThread(u.id, thread.id)).toEqual(["clear", "branch"]);
    // A different user with no host sees no commands.
    const other = await findOrCreateUserByEmail(db, "b@x.com");
    expect(await chat.commandsForThread(other.id, thread.id)).toEqual([]);
    await close();
  });

  it("stop routes an interrupt to the host running a live session", async () => {
    const { close, u, thread, chat, hostSend } = await setup();
    await chat.handleClientSend({ userId: u.id, threadId: thread.id, content: "hi", sourceClientId: "c1" });
    const sessionId = hostSend.mock.calls[0]![0].sessionId;
    hostSend.mockClear();
    await chat.handleStop({ userId: u.id, threadId: thread.id });
    expect(hostSend).toHaveBeenCalledWith({ t: "interrupt", sessionId });
    await close();
  });

  it("stop is a no-op when no turn is running", async () => {
    const { close, u, thread, chat, hostSend } = await setup();
    await chat.handleStop({ userId: u.id, threadId: thread.id });
    expect(hostSend).not.toHaveBeenCalled();
    await close();
  });

  it("clear closes the session and appends a context-cleared divider", async () => {
    const { db, close, u, thread, chat, hostSend, clientSend } = await setup();
    await chat.handleClientSend({ userId: u.id, threadId: thread.id, content: "hi", sourceClientId: "c1" });
    const sessionId = hostSend.mock.calls[0]![0].sessionId;
    await chat.handleHostEvent(sessionId, { type: "session-id", id: "claude-1" });
    await chat.handleHostEvent(sessionId, { type: "done" });

    await chat.handleThreadCommand({ userId: u.id, threadId: thread.id, command: "clear", sourceClientId: "c1" });

    // Session is closed → next send cold-starts a fresh session (runnerSessionId null).
    expect(await getCurrentActiveSession(db, thread.id)).toBeNull();
    // A system divider message was broadcast + persisted.
    const cleared = clientSend.mock.calls.map((c) => c[0]).find(
      (m) => m.t === "message" && m.role === "system" && m.content === THREAD_CLEARED_MARKER,
    );
    expect(cleared).toBeTruthy();
    hostSend.mockClear();
    await chat.handleClientSend({ userId: u.id, threadId: thread.id, content: "fresh", sourceClientId: "c1" });
    expect(hostSend.mock.calls[0]![0]).toMatchObject({ runnerSessionId: null, message: "fresh" });
    await close();
  });

  it("branch clones the transcript into a new thread and forks the parent session on first dispatch", async () => {
    const { db, close, u, thread, chat, hostSend, clientSend, hub } = await setup();
    // publishThreadCreated only reaches list-subscribed clients.
    hub.subscribeList("c1");
    await chat.handleClientSend({ userId: u.id, threadId: thread.id, content: "hello", sourceClientId: "c1" });
    const parentSessionId = hostSend.mock.calls[0]![0].sessionId;
    await chat.handleHostEvent(parentSessionId, { type: "session-id", id: "claude-parent" });
    await chat.handleHostEvent(parentSessionId, { type: "text", text: "hi there" });
    await chat.handleHostEvent(parentSessionId, { type: "done" });

    await chat.handleThreadCommand({ userId: u.id, threadId: thread.id, command: "branch", sourceClientId: "c1" });

    // A thread-created was published for the branch.
    const created = clientSend.mock.calls.map((c) => c[0]).find((m) => m.t === "thread-created");
    expect(created).toBeTruthy();
    const branchId = created!.thread.id;
    expect(created!.thread.title).toContain("分支");

    // Branch inherited the transcript.
    const detail = await getThreadDetail(db, branchId);
    expect(detail?.messages.map((m) => `${m.role}:${m.content}`)).toEqual(["user:hello", "assistant:hi there"]);

    // First message on the branch forks the parent runner session.
    hostSend.mockClear();
    await chat.handleClientSend({ userId: u.id, threadId: branchId, content: "diverge", sourceClientId: "c1" });
    expect(hostSend.mock.calls[0]![0]).toMatchObject({
      forkFromRunnerSessionId: "claude-parent", message: "diverge",
    });
    await close();
  });
});
