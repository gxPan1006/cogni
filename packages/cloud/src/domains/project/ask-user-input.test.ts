import { describe, it, expect, vi } from "vitest";
import { makeTestDb } from "../../db/test-db.js";
import { findOrCreateUserByEmail } from "../../db/users.js";
import { createHost } from "../../db/hosts.js";
import { createThread } from "../../db/threads.js";
import {
  createProject,
  createTask,
  getTask,
  updateTaskState,
} from "../../db/projects.js";
import { HostRouter } from "../../host-router.js";
import { ClientHub } from "../../client-hub.js";
import { ChatDomain } from "../chat.js";
import { HostRpcClient } from "./host-rpc.js";
import { ProjectDomain } from "./index.js";
import type { HostRpcRequest, HostRpcResponse } from "@cogni/contract";

/**
 * Test scope: SP-3 needs-input bridge. When ChatDomain catches an
 * `AskUserQuestion` tool-call on a project task's thread, ProjectDomain
 * pauses the task lifecycle (running → needs-input) and surfaces the
 * question text in the drawer.
 *
 * UI effect this guards: the project board card moves from "进行中" column
 * to "等待输入" column with the question text rendered in the drawer's
 * state stepper area. Drawer reply box becomes the resume path.
 *
 * What we test here (vs lifecycle.test.ts): the *plumbing* — that calling
 * ProjectDomain.handleAskUserQuestion drives the right transition with the
 * right patch payload, and that off-task threads / non-running states are
 * correctly no-op'd.
 */
async function seed() {
  const { db, close } = await makeTestDb();
  const u = await findOrCreateUserByEmail(db, "ask@x.com");
  const host = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Mac" });
  const project = await createProject(db, {
    tenantId: u.tenantId,
    userId: u.id,
    name: "P",
    repoPath: "/r",
    defaultHostId: host.hostId,
  });
  const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
  const task = await createTask(db, { projectId: project.id, title: "T" });
  await updateTaskState(db, task.id, "queued", { executionThreadId: thread.id });

  const send = vi.fn(async (_h: string, _req: HostRpcRequest): Promise<HostRpcResponse> => {
    throw new Error("no host rpc expected in needs-input bridge tests");
  });
  const hostRpc = new HostRpcClient({ sendHostRpc: send });
  const hosts = new HostRouter();
  const clients = new ClientHub();
  const chat = new ChatDomain(db, hosts, clients);

  const projectDomain = new ProjectDomain({
    db, hostRpc, hostRouter: hosts, clients, chat,
  });

  return { db, close, user: u, host, project, thread, task, projectDomain, clients };
}

describe("ProjectDomain.handleAskUserQuestion", () => {
  it("transitions running task to needs-input + writes questionText to needs_input_what", async () => {
    const f = await seed();
    // Move task to running first (orchestrator would do this in real flow).
    await updateTaskState(f.db, f.task.id, "running", {});

    await f.projectDomain.handleAskUserQuestion(f.thread.id, "Context or Redux?");

    const after = await getTask(f.db, f.task.id);
    expect(after?.state).toBe("needs-input");
    expect(after?.needsInputWhat).toBe("Context or Redux?");
    await f.close();
  });

  it("broadcasts task-event(state-changed) on the task topic", async () => {
    const f = await seed();
    await updateTaskState(f.db, f.task.id, "running", {});

    const send = vi.fn();
    f.clients.register({ clientId: "conn-1", userId: f.user.id, send });
    f.clients.subscribeTask("conn-1", f.task.id);

    await f.projectDomain.handleAskUserQuestion(f.thread.id, "Which engine?");

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        t: "task-event",
        kind: "state-changed",
        task: expect.objectContaining({ state: "needs-input" }),
      }),
    );
    await f.close();
  });

  it("no-op when thread isn't a task (free-form chat thread)", async () => {
    const f = await seed();
    // Reuse the same project/host but spin up an orphan thread with no task
    // owning it — this is the SP-1/SP-2 chat case.
    const orphan = await createThread(f.db, { userId: f.user.id, tenantId: f.user.tenantId });

    // Should silently do nothing — no throws, no DB writes.
    await f.projectDomain.handleAskUserQuestion(orphan.id, "any question");

    const stillQueued = await getTask(f.db, f.task.id);
    expect(stillQueued?.state).toBe("queued"); // unchanged
    expect(stillQueued?.needsInputWhat).toBeNull();
    await f.close();
  });

  it("no-op when task isn't in running (e.g. already cancelled)", async () => {
    const f = await seed();
    await updateTaskState(f.db, f.task.id, "cancelled", {});

    await f.projectDomain.handleAskUserQuestion(f.thread.id, "late question");

    const after = await getTask(f.db, f.task.id);
    expect(after?.state).toBe("cancelled"); // unchanged
    expect(after?.needsInputWhat).toBeNull();
    await f.close();
  });

  it("no-op on empty / whitespace questionText", async () => {
    const f = await seed();
    await updateTaskState(f.db, f.task.id, "running", {});

    await f.projectDomain.handleAskUserQuestion(f.thread.id, "   ");

    const after = await getTask(f.db, f.task.id);
    expect(after?.state).toBe("running"); // unchanged
    await f.close();
  });

  it("trims whitespace around the questionText before persisting", async () => {
    const f = await seed();
    await updateTaskState(f.db, f.task.id, "running", {});

    await f.projectDomain.handleAskUserQuestion(f.thread.id, "   Trim me please.   ");

    const after = await getTask(f.db, f.task.id);
    expect(after?.needsInputWhat).toBe("Trim me please.");
    await f.close();
  });
});
