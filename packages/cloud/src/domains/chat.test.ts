import { describe, it, expect, vi } from "vitest";
import { makeTestDb } from "../db/test-db.js";
import { findOrCreateUserByEmail } from "../db/users.js";
import { createThread } from "../db/threads.js";
import { getThreadDetail } from "../db/threads.js";
import { HostRouter } from "../host-router.js";
import { ClientHub } from "../client-hub.js";
import { ChatDomain } from "./chat.js";

describe("ChatDomain", () => {
  it("notifies host-status:false when no host is online", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const hub = new ClientHub();
    const send = vi.fn();
    hub.register({ clientId: "c1", userId: u.id, send });
    hub.subscribe("c1", thread.id);
    const chat = new ChatDomain(db, new HostRouter(), hub);

    await chat.handleClientSend(u.id, thread.id, "hello");

    // user message persisted + broadcast, then host-status:false
    const detail = await getThreadDetail(db, thread.id);
    expect(detail?.messages.map((m) => m.content)).toEqual(["hello"]);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ t: "host-status", online: false }));
    await close();
  });

  it("dispatches to the host and walks a full turn back to a persisted assistant message", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const hub = new ClientHub();
    const clientSend = vi.fn();
    hub.register({ clientId: "c1", userId: u.id, send: clientSend });
    hub.subscribe("c1", thread.id);
    const router = new HostRouter();
    const hostSend = vi.fn();
    router.register({ hostId: "h1", userId: u.id, send: hostSend });
    const chat = new ChatDomain(db, router, hub);

    await chat.handleClientSend(u.id, thread.id, "hi");
    const dispatch = hostSend.mock.calls[0]![0];
    expect(dispatch).toMatchObject({ t: "dispatch", threadId: thread.id, runnerSessionId: null, message: "hi" });
    const sessionId = dispatch.sessionId;

    await chat.handleHostEvent(sessionId, { type: "session-id", id: "claude-1" });
    await chat.handleHostEvent(sessionId, { type: "text", text: "hello back" });
    await chat.handleHostEvent(sessionId, { type: "done" });

    // assistant message persisted from accumulated text
    const detail = await getThreadDetail(db, thread.id);
    expect(detail?.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:hi",
      "assistant:hello back",
    ]);
    // events fanned out to the client with monotonic seq
    const eventMsgs = clientSend.mock.calls.map((c) => c[0]).filter((m) => m.t === "event");
    expect(eventMsgs.map((m) => m.seq)).toEqual([1, 2, 3]);

    // second turn resumes with the stored runnerSessionId
    await chat.handleClientSend(u.id, thread.id, "again");
    expect(hostSend.mock.calls[1]![0]).toMatchObject({ runnerSessionId: "claude-1", message: "again" });
    await close();
  });

  it("marks the session failed and notifies clients when host.send throws", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const hub = new ClientHub();
    const clientSend = vi.fn();
    hub.register({ clientId: "c1", userId: u.id, send: clientSend });
    hub.subscribe("c1", thread.id);
    const router = new HostRouter();
    router.register({ hostId: "h1", userId: u.id, send: () => { throw new Error("socket dead"); } });
    const chat = new ChatDomain(db, router, hub);

    await chat.handleClientSend(u.id, thread.id, "hi");

    expect(clientSend).toHaveBeenCalledWith(expect.objectContaining({ t: "host-status", online: false }));
    await close();
  });

  it("handleSessionUpdate persists the session status", async () => {
    const { db, close } = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "a@x.com");
    const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
    const chat = new ChatDomain(db, new HostRouter(), new ClientHub());
    // create the session by sending once (no host -> still creates the runner session)
    await chat.handleClientSend(u.id, thread.id, "hi");
    const { getOrCreateRunnerSession } = await import("../db/sessions.js");
    const session = await getOrCreateRunnerSession(db, thread.id, "claude-code");
    await chat.handleSessionUpdate(session.id, "failed");
    const after = await getOrCreateRunnerSession(db, thread.id, "claude-code");
    expect(after.status).toBe("failed");
    await close();
  });
});
