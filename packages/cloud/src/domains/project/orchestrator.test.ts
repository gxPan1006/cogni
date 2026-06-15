import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "../../db/test-db.js";
import { findOrCreateUserByEmail } from "../../db/users.js";
import { createHost, setHostStatus } from "../../db/hosts.js";
import { createThread, appendMessage } from "../../db/threads.js";
import { openRunnerSession, setRunnerSessionStatus } from "../../db/sessions.js";
import { listComments } from "../../db/task-comments.js";
import { hosts as hostsTable } from "../../db/schema.js";
import {
  createProject,
  createTask,
  getTask,
  listTaskRuns,
  updateTaskState,
} from "../../db/projects.js";
import { HostRouter } from "../../host-router.js";
import { ClientHub } from "../../client-hub.js";
import { HostRpcClient } from "./host-rpc.js";
import { ProjectOrchestrator } from "./orchestrator.js";
import type { HostRpcRequest, HostRpcResponse, CloudToHost } from "@cogni/contract";

/**
 * Seeds: user + host + project + thread + a queued task with executionThreadId
 * preset (orchestrator skips tasks without one — Track C wires that, we
 * pre-seed for unit tests).
 *
 * The HostRouter has the host registered with a vi.fn() send so we can assert
 * dispatch frames. host-rpc handler is configured per-test via `setHandler`.
 */
async function seedFixture(opts: {
  mergePolicy?: "require-review" | "auto-merge" | "auto-merge-if-tests-pass";
  defaultAdapter?: "claude-code" | "claude-code-snapshot" | "codex";
} = {}) {
  const { db, close } = await makeTestDb();
  const u = await findOrCreateUserByEmail(db, "orch@x.com");
  const host = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Mac" });
  // Host status is created as 'offline'; mark online + fresh lastSeen so
  // the offline-warn branch doesn't trigger.
  await setHostStatus(db, host.hostId, "online");
  const project = await createProject(db, {
    tenantId: u.tenantId,
    userId: u.id,
    name: "P",
    repoPath: "/r",
    defaultHostId: host.hostId,
    mergePolicy: opts.mergePolicy ?? "require-review",
    concurrencyLimit: 2,
  });
  const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
  const task = await createTask(db, { projectId: project.id, title: "Do thing" });
  // executionThreadId is required for orchestrator dispatch path — Track C
  // route normally seeds this; we patch directly.
  await updateTaskState(db, task.id, "queued", { executionThreadId: thread.id });

  let rpcHandler: (req: HostRpcRequest) => Promise<HostRpcResponse> = async () => {
    throw new Error("no rpc handler set");
  };
  const send = vi.fn(async (_h: string, req: HostRpcRequest) => rpcHandler(req));
  const hostRpc = new HostRpcClient({ sendHostRpc: send });

  const hostRouter = new HostRouter();
  const hostSend = vi.fn();
  hostRouter.register({
    hostId: host.hostId,
    userId: u.id,
    send: hostSend,
    adapters: ["claude-code", "claude-code-snapshot", "codex"],
    defaultAdapter: opts.defaultAdapter ?? "claude-code",
  });

  const clients = new ClientHub();

  const orchestrator = new ProjectOrchestrator({
    db, hostRpc, hostRouter, clients,
  });

  return {
    db, close, user: u, host, project, thread, task,
    orchestrator, hostSend, send,
    setHandler(fn: (req: HostRpcRequest) => Promise<HostRpcResponse>) {
      rpcHandler = fn;
    },
  };
}

const okWorktreeFlow = async (req: HostRpcRequest): Promise<HostRpcResponse> => {
  if (req.method === "git-init-if-missing") {
    return { ok: true, method: "git-init-if-missing", result: { initialized: false } };
  }
  if (req.method === "git-worktree-create") {
    return { ok: true, method: "git-worktree-create", result: { worktreePath: req.params.worktreePath } };
  }
  throw new Error(`unexpected ${req.method}`);
};

describe("ProjectOrchestrator dispatch", () => {
  it("dispatches a queued task: queued→running + dispatch frame + task_run + state-changed broadcast", async () => {
    const f = await seedFixture();
    f.setHandler(okWorktreeFlow);

    // Subscribe a client to the project channel so we can see the broadcast.
    const sub = vi.fn();
    // Accessing f.orchestrator below lazily constructs it and captures deps.
    const hub = (f.orchestrator as unknown as { deps: { clients: ClientHub } }).deps.clients;
    hub.register({ clientId: "c1", userId: f.user.id, send: sub });
    hub.subscribeProject("c1", f.project.id);

    await f.orchestrator.tick();

    const after = await getTask(f.db, f.task.id);
    expect(after?.state).toBe("running");
    expect(after?.hostId).toBe(f.host.hostId);
    expect(after?.worktreePath).toBe(`/r/.worktrees/${f.task.ref}`);
    expect(after?.branchName).toBe(`task/${f.task.ref.toLowerCase()}`);
    expect(after?.startedAt).not.toBeNull();
    expect(after?.adapter).toBe("claude-code");

    // Dispatch frame went to host with title + description in message.
    const frame = f.hostSend.mock.calls[0]?.[0] as CloudToHost;
    expect(frame).toMatchObject({
      t: "dispatch",
      threadId: f.thread.id,
      adapter: "claude-code",
      runnerSessionId: null,
    });

    // One task_run row created.
    const runs = await listTaskRuns(f.db, f.task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.attemptNumber).toBe(1);

    // Broadcast carried task-event state-changed.
    const taskEvents = sub.mock.calls.map((c) => c[0]).filter((m) => m.t === "task-event");
    expect(taskEvents.length).toBeGreaterThan(0);
    expect(taskEvents[0]).toMatchObject({ kind: "state-changed" });

    await f.close();
  });

  it("uses the host default Claude snapshot adapter when the task has no explicit adapter", async () => {
    const f = await seedFixture({ defaultAdapter: "claude-code-snapshot" });
    f.setHandler(okWorktreeFlow);

    await f.orchestrator.tick();

    const after = await getTask(f.db, f.task.id);
    expect(after?.adapter).toBe("claude-code-snapshot");
    const frame = f.hostSend.mock.calls[0]?.[0] as CloudToHost;
    expect(frame).toMatchObject({ adapter: "claude-code-snapshot" });
    await f.close();
  });

  it("injects unconsumed human comments into the dispatch message and stamps them consumed", async () => {
    const f = await seedFixture();
    f.setHandler(okWorktreeFlow);
    const { insertComment, gatherUnconsumedUserComments } = await import("../../db/task-comments.js");
    await insertComment(f.db, {
      taskId: f.task.id,
      author: "user",
      body: "用深色主题",
      state: "queued",
      authorUserId: f.user.id,
    });

    await f.orchestrator.tick();

    const frame = f.hostSend.mock.calls[0]?.[0] as CloudToHost;
    expect(frame.message).toContain("# 人类补充说明");
    expect(frame.message).toContain("用深色主题");
    // The comment was carried into a run and stamped consumed.
    expect(await gatherUnconsumedUserComments(f.db, f.task.id)).toEqual([]);
    await f.close();
  });

  it("respects concurrency limit (concurrencyLimit=1, two queued → only one dispatches)", async () => {
    const f = await seedFixture();
    f.setHandler(okWorktreeFlow);
    // Set project to cap=1.
    const { db, project } = f;
    const { updateProject } = await import("../../db/projects.js");
    await updateProject(db, project.id, { concurrencyLimit: 1 });
    // Add a second queued task on the same project.
    const t2 = await createTask(db, { projectId: project.id, title: "Second" });
    await updateTaskState(db, t2.id, "queued", { executionThreadId: f.thread.id });

    await f.orchestrator.tick();

    const taskA = await getTask(db, f.task.id);
    const taskB = await getTask(db, t2.id);
    // One of them moved to running, the other stayed queued.
    const states = [taskA?.state, taskB?.state].sort();
    expect(states).toEqual(["queued", "running"]);

    await f.close();
  });

  it("skips dispatch when host RPC throws host-offline (task stays queued)", async () => {
    const f = await seedFixture();
    f.setHandler(async () => {
      throw { code: "host-offline", message: "h offline" };
    });

    await f.orchestrator.tick();

    const after = await getTask(f.db, f.task.id);
    expect(after?.state).toBe("queued");
    // No dispatch frame sent.
    expect(f.hostSend).not.toHaveBeenCalled();
    await f.close();
  });

  it("skips dispatch when task has no executionThreadId", async () => {
    const f = await seedFixture();
    f.setHandler(okWorktreeFlow);
    await updateTaskState(f.db, f.task.id, "queued", { executionThreadId: null });

    await f.orchestrator.tick();

    const after = await getTask(f.db, f.task.id);
    expect(after?.state).toBe("queued");
    await f.close();
  });

  it("re-entrancy guard: parallel tick() invocations don't dispatch the same task twice", async () => {
    const f = await seedFixture();
    f.setHandler(okWorktreeFlow);

    await Promise.all([f.orchestrator.tick(), f.orchestrator.tick(), f.orchestrator.tick()]);

    const runs = await listTaskRuns(f.db, f.task.id);
    expect(runs).toHaveLength(1);
    await f.close();
  });
});

describe("ProjectOrchestrator reconcile", () => {
  it("warns (no DB change) when running task's host went offline > 60s ago", async () => {
    const f = await seedFixture();
    // Pre-move the task to running.
    await updateTaskState(f.db, f.task.id, "running", {
      hostId: f.host.hostId,
      worktreePath: "/r/.worktrees/T-1",
      branchName: "task/t-1",
      startedAt: new Date(),
    });
    // Backdate the host's last_seen to look offline > 60s.
    await f.db.update(hostsTable)
      .set({ status: "offline", lastSeen: new Date(Date.now() - 120_000) })
      .where(eq(hostsTable.id, f.host.hostId));

    await f.orchestrator.tick();

    const after = await getTask(f.db, f.task.id);
    // Reconcile only warns; task stays running (SP-2 session-resume recovers).
    expect(after?.state).toBe("running");
    await f.close();
  });

  it("re-runs merge gate on reviewing tasks when project's mergePolicy is no longer require-review", async () => {
    const f = await seedFixture({ mergePolicy: "auto-merge" });
    // Move task directly to reviewing (simulating the moment after the
    // ChatDomain finalizes 'done' under a prior require-review setting).
    await updateTaskState(f.db, f.task.id, "reviewing", {
      hostId: f.host.hostId,
      worktreePath: "/r/.worktrees/T-1",
      branchName: "task/t-1",
      startedAt: new Date(),
    });
    f.setHandler(async (req) => {
      if (req.method === "git-merge-to-main") {
        return { ok: true, method: "git-merge-to-main", result: { ok: true } };
      }
      if (req.method === "git-worktree-remove") {
        return { ok: true, method: "git-worktree-remove", result: { removed: true } };
      }
      return okWorktreeFlow(req);
    });

    await f.orchestrator.tick();

    const after = await getTask(f.db, f.task.id);
    expect(after?.state).toBe("done");
    expect(after?.completedAt).not.toBeNull();
    await f.close();
  });

  it("captures a worker handoff comment when a running task finalizes to reviewing", async () => {
    const f = await seedFixture({ mergePolicy: "require-review" });
    await updateTaskState(f.db, f.task.id, "running", {
      hostId: f.host.hostId,
      worktreePath: "/r/.worktrees/T-1",
      branchName: "task/t-1",
      startedAt: new Date(),
    });
    // A completed runner session on the execution thread + the worker's final
    // handoff message — this is what maybeFinalizeRunningTask reacts to.
    const session = await openRunnerSession(f.db, {
      threadId: f.thread.id, hostId: f.host.hostId, adapter: "claude-code",
    });
    await setRunnerSessionStatus(f.db, session.id, "completed");
    await appendMessage(f.db, {
      threadId: f.thread.id, role: "assistant",
      content: "做了什么: 写了 cc-view 查看器\n交付物在哪: 当前分支",
    });
    f.setHandler(async (req) => req as never); // require-review needs no host RPC

    await f.orchestrator.tick();

    expect((await getTask(f.db, f.task.id))?.state).toBe("reviewing");
    const worker = (await listComments(f.db, f.task.id)).find((c) => c.author === "worker");
    expect(worker, "a worker handoff card should be created on finalize").toBeTruthy();
    expect(worker!.state).toBe("reviewing");
    expect(worker!.body).toContain("cc-view");
    await f.close();
  });

  it("leaves reviewing task alone when project policy is still require-review", async () => {
    const f = await seedFixture({ mergePolicy: "require-review" });
    await updateTaskState(f.db, f.task.id, "reviewing", {
      hostId: f.host.hostId,
      worktreePath: "/w",
      branchName: "task/t-1",
    });
    // Host-rpc handler set to throw if invoked — proves we don't call it.
    f.setHandler(async () => {
      throw new Error("should not call host for require-review");
    });

    await f.orchestrator.tick();

    const after = await getTask(f.db, f.task.id);
    expect(after?.state).toBe("reviewing");
    await f.close();
  });
});

describe("ProjectOrchestrator start/stop", () => {
  it("start() schedules the interval; stop() clears it", async () => {
    const f = await seedFixture();
    f.setHandler(okWorktreeFlow);
    f.orchestrator.start();
    // Re-entrancy: starting twice is a no-op.
    f.orchestrator.start();
    f.orchestrator.stop();
    // stop() is idempotent.
    f.orchestrator.stop();
    await f.close();
  });
});
