import { describe, it, expect, vi } from "vitest";
import { makeTestDb } from "../../db/test-db.js";
import { findOrCreateUserByEmail } from "../../db/users.js";
import { createHost } from "../../db/hosts.js";
import { createThread } from "../../db/threads.js";
import { createProject, createTask, getTask, updateTaskState } from "../../db/projects.js";
import { openRunnerSession, getLatestSessionForThread } from "../../db/sessions.js";
import { HostRouter } from "../../host-router.js";
import { ClientHub } from "../../client-hub.js";
import { HostRpcClient } from "./host-rpc.js";
import { ProjectDomain } from "./index.js";
import type { ChatDomain } from "../chat.js";
import type { HostRpcRequest, HostRpcResponse } from "@cogni/contract";

/**
 * Test scope: SP-3 kanban drag — ProjectDomain.moveTaskToState maps each
 * target column to a lifecycle action. Mirrors the ask-user-input harness;
 * host-rpc handler is configurable per-test for the accept+merge path.
 */
async function seed(opts: { mergePolicy?: "require-review" | "auto-merge" } = {}) {
  const { db, close } = await makeTestDb();
  const u = await findOrCreateUserByEmail(db, "move@x.com");
  const host = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Mac" });
  const project = await createProject(db, {
    tenantId: u.tenantId,
    userId: u.id,
    name: "P",
    repoPath: "/r",
    defaultHostId: host.hostId,
    mergePolicy: opts.mergePolicy ?? "require-review",
  });
  const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
  const task = await createTask(db, { projectId: project.id, title: "T" });
  await updateTaskState(db, task.id, "queued", { executionThreadId: thread.id });

  let rpcHandler: (req: HostRpcRequest) => Promise<HostRpcResponse> = async () => {
    throw new Error("no rpc handler set");
  };
  const send = vi.fn(async (_h: string, req: HostRpcRequest) => rpcHandler(req));
  const hostRpc = new HostRpcClient({ sendHostRpc: send });
  const hosts = new HostRouter();
  const clients = new ClientHub();
  const chat = { handleClientSend: vi.fn() } as unknown as ChatDomain;

  const domain = new ProjectDomain({ db, hostRpc, hostRouter: hosts, clients, chat });

  return {
    db,
    close,
    user: u,
    host,
    project,
    thread,
    task,
    domain,
    setHandler(fn: (req: HostRpcRequest) => Promise<HostRpcResponse>) {
      rpcHandler = fn;
    },
  };
}

describe("ProjectDomain.moveTaskToState", () => {
  it("same state is a no-op", async () => {
    const f = await seed();
    await updateTaskState(f.db, f.task.id, "running", {});
    const updated = await f.domain.moveTaskToState(f.task.id, "running");
    expect(updated.state).toBe("running");
    await f.close();
  });

  it("done → queued re-queues via the retry path (increments retries)", async () => {
    const f = await seed();
    await updateTaskState(f.db, f.task.id, "done", { completedAt: new Date() });
    const updated = await f.domain.moveTaskToState(f.task.id, "queued");
    expect(updated.state).toBe("queued");
    expect(updated.retries).toBe(1);
    await f.close();
  });

  it("running → queued stops the runner then re-queues", async () => {
    const f = await seed();
    await updateTaskState(f.db, f.task.id, "running", {
      hostId: f.host.hostId,
      startedAt: new Date(),
    });
    const session = await openRunnerSession(f.db, {
      threadId: f.thread.id,
      hostId: f.host.hostId,
      adapter: "claude-code",
    });

    const updated = await f.domain.moveTaskToState(f.task.id, "queued");
    expect(updated.state).toBe("queued");
    // Runner session was closed (detached).
    const latest = await getLatestSessionForThread(f.db, f.thread.id);
    expect(latest!.id).toBe(session.id);
    expect(latest!.status).toBe("closed");
    await f.close();
  });

  it("reviewing → done accepts + merges (merge gate)", async () => {
    const f = await seed({ mergePolicy: "require-review" });
    await updateTaskState(f.db, f.task.id, "reviewing", {
      hostId: f.host.hostId,
      worktreePath: "/r/.worktrees/T-1",
      branchName: "task/t-1",
    });
    f.setHandler(async (req) => {
      if (req.method === "git-merge-to-main") {
        return { ok: true, method: "git-merge-to-main", result: { ok: true } };
      }
      if (req.method === "git-worktree-remove") {
        return { ok: true, method: "git-worktree-remove", result: { removed: true } };
      }
      throw new Error(`unexpected ${req.method}`);
    });

    const updated = await f.domain.moveTaskToState(f.task.id, "done");
    expect(updated.state).toBe("done");
    await f.close();
  });

  it("running → reviewing is a direct hop and stops the runner", async () => {
    const f = await seed();
    await updateTaskState(f.db, f.task.id, "running", {
      hostId: f.host.hostId,
      worktreePath: "/r/.worktrees/T-1",
      startedAt: new Date(),
    });
    const session = await openRunnerSession(f.db, {
      threadId: f.thread.id,
      hostId: f.host.hostId,
      adapter: "claude-code",
    });

    const updated = await f.domain.moveTaskToState(f.task.id, "reviewing");
    expect(updated.state).toBe("reviewing");
    const latest = await getLatestSessionForThread(f.db, f.thread.id);
    expect(latest!.id).toBe(session.id);
    expect(latest!.status).toBe("closed");
    await f.close();
  });

  it("running → needs-input pauses awaiting input", async () => {
    const f = await seed();
    await updateTaskState(f.db, f.task.id, "running", {});
    const updated = await f.domain.moveTaskToState(f.task.id, "needs-input");
    expect(updated.state).toBe("needs-input");
    await f.close();
  });

  it("needs-input → running resumes directly (clears needsInputWhat)", async () => {
    const f = await seed();
    await updateTaskState(f.db, f.task.id, "needs-input", { needsInputWhat: "which engine?" });
    const updated = await f.domain.moveTaskToState(f.task.id, "running");
    expect(updated.state).toBe("running");
    expect(updated.needsInputWhat).toBeNull();
    await f.close();
  });

  it("incoherent target (queued → done) applies a manual state override", async () => {
    const f = await seed();
    // task is queued; "done" has no lifecycle action from queued → force.
    const updated = await f.domain.moveTaskToState(f.task.id, "done");
    expect(updated.state).toBe("done");
    expect(updated.completedAt).not.toBeNull();
    const persisted = await getTask(f.db, f.task.id);
    expect(persisted!.state).toBe("done");
    await f.close();
  });
});
