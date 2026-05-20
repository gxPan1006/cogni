import { describe, it, expect, vi } from "vitest";
import type { CloudToHost } from "@cogni/contract";
import { makeTestDb } from "../db/test-db.js";
import { findOrCreateUserByEmail } from "../db/users.js";
import { createHost } from "../db/hosts.js";
import { HostRouter } from "../host-router.js";
import { ClientHub } from "../client-hub.js";
import { getOrCreateWorkspaceThread } from "../db/threads.js";
import { WorkspaceChatDomain } from "./workspace-chat.js";

/**
 * Test scope: SP-4 WorkspaceChatDomain send/dispatch path. The orchestrator
 * floating bar's message goes to a 'workspace' thread; this domain persists it,
 * picks an online host, and dispatches an `orchestrator: true` frame to it.
 *
 * UI effect guarded: typing in the bottom workspace-chat bar and hitting send
 * makes the message appear (user bubble), then the orchestrator runner streams
 * its reply back; when no host is online the bar shows the "no host online"
 * state instead of dispatching.
 */
async function seed() {
  const { db, close } = await makeTestDb();
  const user = await findOrCreateUserByEmail(db, "wschat@x.com");
  const host = await createHost(db, { userId: user.id, tenantId: user.tenantId, name: "Mac" });
  const hosts = new HostRouter();
  const clients = new ClientHub();
  const domain = new WorkspaceChatDomain(db, hosts, clients);
  return { db, close, user, host, hosts, clients, domain };
}

describe("WorkspaceChatDomain.handleClientSend", () => {
  it("dispatches an orchestrator frame to an online host", async () => {
    const { db, close, user, host, hosts, domain } = await seed();
    const sends: CloudToHost[] = [];
    hosts.register({
      hostId: host.hostId,
      userId: user.id,
      send: (m) => sends.push(m),
    });
    const thread = await getOrCreateWorkspaceThread(db, {
      userId: user.id,
      tenantId: user.tenantId,
    });
    await domain.handleClientSend({
      userId: user.id,
      threadId: thread.id,
      content: "建个任务",
      sourceClientId: "c1",
    });
    expect(sends[0]).toMatchObject({
      t: "dispatch",
      orchestrator: true,
      threadId: thread.id,
      adapter: "claude-code",
    });
    await close();
  });

  it("includes an orchestrator preamble on the first turn", async () => {
    const { db, close, user, host, hosts, domain } = await seed();
    const sends: CloudToHost[] = [];
    hosts.register({ hostId: host.hostId, userId: user.id, send: (m) => sends.push(m) });
    const thread = await getOrCreateWorkspaceThread(db, {
      userId: user.id,
      tenantId: user.tenantId,
    });
    await domain.handleClientSend({
      userId: user.id,
      threadId: thread.id,
      content: "hi",
      sourceClientId: "c1",
    });
    const frame = sends[0];
    expect(frame?.t).toBe("dispatch");
    if (frame?.t === "dispatch") {
      expect(frame.message).toContain("Cogni");
      expect(frame.message.endsWith("hi")).toBe(true);
    }
    await close();
  });

  it("sends no-host-online when no host is connected", async () => {
    const { db, close, user, clients, domain } = await seed();
    const conn: unknown[] = [];
    vi.spyOn(clients, "sendToConn").mockImplementation((_id, m) => conn.push(m));
    const thread = await getOrCreateWorkspaceThread(db, {
      userId: user.id,
      tenantId: user.tenantId,
    });
    await domain.handleClientSend({
      userId: user.id,
      threadId: thread.id,
      content: "x",
      sourceClientId: "c1",
    });
    expect(conn[0]).toMatchObject({ t: "no-host-online", threadId: thread.id });
    await close();
  });
});
