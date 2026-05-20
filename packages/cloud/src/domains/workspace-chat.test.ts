import { describe, it, expect, vi } from "vitest";
import type { CloudToHost } from "@cogni/contract";
import { makeTestDb } from "../db/test-db.js";
import { findOrCreateUserByEmail } from "../db/users.js";
import { createHost } from "../db/hosts.js";
import { HostRouter } from "../host-router.js";
import { ClientHub } from "../client-hub.js";
import { getOrCreateWorkspaceThread, getOrCreateProjectThread } from "../db/threads.js";
import { createProject, createTask } from "../db/projects.js";
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

  it("carries the orchestrator preamble via appendSystemPrompt, message stays raw", async () => {
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
      // The preamble rides on --append-system-prompt, not the user message,
      // so the chat bubble shows only the raw text.
      expect(frame.message).toBe("hi");
      expect(frame.appendSystemPrompt).toContain("Cogni");
    }
    await close();
  });

  it("prefers the project's default host for a project-scoped thread", async () => {
    const { db, close, user, host, hosts, clients } = await seed();
    // A second online host that is NOT the project default; the domain must
    // still pick the project's default host for a project-linked thread.
    const other = await createHost(db, { userId: user.id, tenantId: user.tenantId, name: "Other" });
    const sends: Array<{ hostId: string; msg: CloudToHost }> = [];
    hosts.register({ hostId: other.hostId, userId: user.id, send: (m) => sends.push({ hostId: other.hostId, msg: m }) });
    hosts.register({ hostId: host.hostId, userId: user.id, send: (m) => sends.push({ hostId: host.hostId, msg: m }) });
    // Project whose default host is `host`, linked to its own orchestrator thread.
    const project = await createProject(db, {
      userId: user.id,
      tenantId: user.tenantId,
      name: "P",
      repoPath: "/tmp/p",
      defaultHostId: host.hostId,
    });
    const thread = await getOrCreateProjectThread(db, {
      id: project.id,
      userId: user.id,
      tenantId: user.tenantId,
      threadId: null,
    });
    const domain = new WorkspaceChatDomain(db, hosts, clients);
    await domain.handleClientSend({
      userId: user.id,
      threadId: thread.id,
      content: "建个任务",
      sourceClientId: "c1",
    });
    expect(sends[0]?.hostId).toBe(host.hostId);
    await close();
  });

  it("folds the focused task (ref/title/state) into appendSystemPrompt when taskId is sent", async () => {
    const { db, close, user, host, hosts, clients } = await seed();
    const sends: CloudToHost[] = [];
    hosts.register({ hostId: host.hostId, userId: user.id, send: (m) => sends.push(m) });
    const project = await createProject(db, {
      userId: user.id,
      tenantId: user.tenantId,
      name: "贪吃蛇游戏",
      repoPath: "/tmp/snake",
      defaultHostId: host.hostId,
    });
    const task = await createTask(db, { projectId: project.id, title: "加一个计分板" });
    const thread = await getOrCreateProjectThread(db, {
      id: project.id,
      userId: user.id,
      tenantId: user.tenantId,
      threadId: null,
    });
    const domain = new WorkspaceChatDomain(db, hosts, clients);
    await domain.handleClientSend({
      userId: user.id,
      threadId: thread.id,
      content: "把这个改成横屏",
      sourceClientId: "c1",
      taskId: task.id,
    });
    const frame = sends[0];
    expect(frame?.t).toBe("dispatch");
    if (frame?.t === "dispatch") {
      expect(frame.message).toBe("把这个改成横屏"); // user text stays raw
      expect(frame.appendSystemPrompt).toContain(task.ref);
      expect(frame.appendSystemPrompt).toContain("加一个计分板");
      expect(frame.appendSystemPrompt).toContain(`taskId=${task.id}`);
    }
    await close();
  });

  it("ignores a taskId that belongs to a different project (no leak)", async () => {
    const { db, close, user, host, hosts, clients } = await seed();
    const sends: CloudToHost[] = [];
    hosts.register({ hostId: host.hostId, userId: user.id, send: (m) => sends.push(m) });
    const projA = await createProject(db, { userId: user.id, tenantId: user.tenantId, name: "A", repoPath: "/tmp/a", defaultHostId: host.hostId });
    const projB = await createProject(db, { userId: user.id, tenantId: user.tenantId, name: "B", repoPath: "/tmp/b", defaultHostId: host.hostId });
    const taskB = await createTask(db, { projectId: projB.id, title: "B 的任务" });
    const threadA = await getOrCreateProjectThread(db, { id: projA.id, userId: user.id, tenantId: user.tenantId, threadId: null });
    const domain = new WorkspaceChatDomain(db, hosts, clients);
    await domain.handleClientSend({
      userId: user.id,
      threadId: threadA.id,
      content: "x",
      sourceClientId: "c1",
      taskId: taskB.id,
    });
    const frame = sends[0];
    if (frame?.t === "dispatch") {
      expect(frame.appendSystemPrompt).not.toContain("B 的任务");
      expect(frame.appendSystemPrompt).not.toContain(`taskId=${taskB.id}`);
    }
    await close();
  });

  it("never emits literal 'undefined' for a blank project name", async () => {
    const { db, close, user, host, hosts, clients } = await seed();
    const sends: CloudToHost[] = [];
    hosts.register({ hostId: host.hostId, userId: user.id, send: (m) => sends.push(m) });
    // A project whose name is empty/whitespace — the bug class behind the
    // literal「undefined」placeholder. The preamble must degrade gracefully.
    const project = await createProject(db, { userId: user.id, tenantId: user.tenantId, name: "   ", repoPath: "/tmp/blank", defaultHostId: host.hostId });
    const thread = await getOrCreateProjectThread(db, { id: project.id, userId: user.id, tenantId: user.tenantId, threadId: null });
    const domain = new WorkspaceChatDomain(db, hosts, clients);
    await domain.handleClientSend({ userId: user.id, threadId: thread.id, content: "x", sourceClientId: "c1" });
    const frame = sends[0];
    if (frame?.t === "dispatch") {
      expect(frame.appendSystemPrompt).not.toContain("undefined");
      expect(frame.appendSystemPrompt).toContain(`projectId=${project.id}`);
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
