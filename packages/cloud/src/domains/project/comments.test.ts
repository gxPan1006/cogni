import { describe, it, expect, vi } from "vitest";
import { makeTestDb } from "../../db/test-db.js";
import { findOrCreateUserByEmail } from "../../db/users.js";
import { createHost } from "../../db/hosts.js";
import { createThread, appendMessage } from "../../db/threads.js";
import {
  createProject,
  createTask,
  getTask,
  listTaskRuns,
  createTaskRun,
  updateTaskState,
} from "../../db/projects.js";
import { openRunnerSession } from "../../db/sessions.js";
import {
  insertComment,
  listComments,
  gatherUnconsumedUserComments,
} from "../../db/task-comments.js";
import { HostRouter } from "../../host-router.js";
import { ClientHub } from "../../client-hub.js";
import { HostRpcClient } from "./host-rpc.js";
import { ProjectDomain } from "./index.js";
import { renderCommentsForRunner } from "./comments.js";
import type { ChatDomain } from "../chat.js";
import type { HostRpcRequest, HostRpcResponse, TaskComment } from "@cogni/contract";

/**
 * Test scope: SP-3 task-comment feed (主页面).
 *   - renderCommentsForRunner pure helper
 *   - worker-note capture at needs-input + done/reviewing transitions
 *   - comment injection folded into replyToTask
 *   - addUserComment / deleteUserComment domain methods + broadcast
 *
 * Harness mirrors ask-user-input.test.ts but injects a *fake* ChatDomain that
 * records the `handleClientSend` calls (so we can assert the folded content
 * without a real runner).
 */
const mk = (body: string): TaskComment => ({
  id: "c",
  taskId: "t",
  author: "user",
  body,
  state: "queued",
  runnerSessionId: null,
  consumedByRunId: null,
  authorUserId: "u",
  createdAt: "2026-05-21T00:00:00.000Z",
});

describe("renderCommentsForRunner", () => {
  it("returns null for no comments", () => {
    expect(renderCommentsForRunner([])).toBeNull();
  });
  it("renders a labeled bullet list", () => {
    const out = renderCommentsForRunner([mk("改成深色主题"), mk("加音效")]);
    expect(out).toContain("# 人类补充说明");
    expect(out).toContain("- 改成深色主题");
    expect(out).toContain("- 加音效");
  });
});

async function seed() {
  const { db, close } = await makeTestDb();
  const u = await findOrCreateUserByEmail(db, "comments@x.com");
  const host = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "Mac" });
  const project = await createProject(db, {
    tenantId: u.tenantId,
    userId: u.id,
    name: "P",
    repoPath: "/r",
    defaultHostId: host.hostId,
    mergePolicy: "require-review",
  });
  const thread = await createThread(db, { userId: u.id, tenantId: u.tenantId });
  const task = await createTask(db, { projectId: project.id, title: "T" });
  await updateTaskState(db, task.id, "queued", { executionThreadId: thread.id });

  const send = vi.fn(async (_h: string, _req: HostRpcRequest): Promise<HostRpcResponse> => {
    throw new Error("no host rpc expected in comment tests");
  });
  const hostRpc = new HostRpcClient({ sendHostRpc: send });
  const hosts = new HostRouter();
  const clients = new ClientHub();

  // Fake ChatDomain — only `handleClientSend` is exercised by replyToTask.
  const sentSends: { content: string }[] = [];
  const chat = {
    handleClientSend: vi.fn(async (input: { content: string }) => {
      sentSends.push({ content: input.content });
    }),
  } as unknown as ChatDomain;

  const domain = new ProjectDomain({
    db,
    hostRpc,
    hostRouter: hosts,
    clients,
    chat,
  });

  return { db, close, user: u, host, project, thread, task, domain, clients, sentSends };
}

describe("worker-note capture at transitions", () => {
  it("handleAskUserQuestion writes a needs-input worker card", async () => {
    const f = await seed();
    await updateTaskState(f.db, f.task.id, "running", {});

    await f.domain.handleAskUserQuestion(f.thread.id, "需要确认配色?");

    const comments = await listComments(f.db, f.task.id);
    expect(
      comments.some(
        (c) => c.author === "worker" && c.state === "needs-input" && c.body.includes("需要确认配色"),
      ),
    ).toBe(true);
    await f.close();
  });

  it("handleRunnerDoneForTask writes a done/reviewing worker card from the latest assistant message", async () => {
    const f = await seed();
    await updateTaskState(f.db, f.task.id, "running", {
      hostId: f.host.hostId,
      worktreePath: "/r/.worktrees/T-1",
      branchName: "task/t-1",
      startedAt: new Date(),
    });
    await appendMessage(f.db, {
      threadId: f.thread.id,
      role: "assistant",
      content: "做了什么: 写了 snake.html\n交付物在哪: 当前分支\n下一步: 试玩一下",
    });

    await f.domain.handleRunnerDoneForTask(f.task.id);

    const after = await listComments(f.db, f.task.id);
    const note = after.find((c) => c.author === "worker");
    expect(note).toBeTruthy();
    expect(note!.state === "done" || note!.state === "reviewing").toBe(true);
    expect(note!.body).toContain("snake.html");
    await f.close();
  });

  it("broadcasts a task-comment(created) frame to per-task subscribers", async () => {
    const f = await seed();
    await updateTaskState(f.db, f.task.id, "running", {});
    const sub = vi.fn();
    f.clients.register({ clientId: "conn-1", userId: f.user.id, send: sub });
    f.clients.subscribeTask("conn-1", f.task.id);

    await f.domain.handleAskUserQuestion(f.thread.id, "确认一下?");

    expect(sub).toHaveBeenCalledWith(
      expect.objectContaining({ t: "task-comment", kind: "created" }),
    );
    await f.close();
  });
});

describe("comment injection at replyToTask", () => {
  it("folds unconsumed comments into the forwarded content and consumes them", async () => {
    const f = await seed();
    // Put the task into needs-input with a live run to stamp against.
    await updateTaskState(f.db, f.task.id, "needs-input", {});
    const session = await openRunnerSession(f.db, {
      threadId: f.thread.id,
      hostId: f.host.hostId,
      adapter: "claude-code",
    });
    await createTaskRun(f.db, {
      taskId: f.task.id,
      runnerSessionId: session.id,
      attemptNumber: 1,
      startedAt: new Date(),
    });
    await insertComment(f.db, {
      taskId: f.task.id,
      author: "user",
      body: "顺便加深色",
      state: "needs-input",
      authorUserId: f.user.id,
    });

    await f.domain.replyToTask({
      taskId: f.task.id,
      userId: f.user.id,
      content: "好的继续",
      sourceClientId: "test",
    });

    expect(f.sentSends.at(-1)!.content).toContain("好的继续");
    expect(f.sentSends.at(-1)!.content).toContain("顺便加深色");
    expect(await gatherUnconsumedUserComments(f.db, f.task.id)).toEqual([]);
    await f.close();
  });

  it("leaves content unchanged when there are no comments", async () => {
    const f = await seed();
    await updateTaskState(f.db, f.task.id, "needs-input", {});

    await f.domain.replyToTask({
      taskId: f.task.id,
      userId: f.user.id,
      content: "just a reply",
      sourceClientId: "test",
    });

    expect(f.sentSends.at(-1)!.content).toBe("just a reply");
    await f.close();
  });
});

describe("addUserComment / deleteUserComment", () => {
  it("addUserComment inserts an inert user comment and broadcasts; task state unchanged", async () => {
    const f = await seed();
    await updateTaskState(f.db, f.task.id, "done", { completedAt: new Date() });
    const sub = vi.fn();
    f.clients.register({ clientId: "conn-1", userId: f.user.id, send: sub });
    f.clients.subscribeTask("conn-1", f.task.id);

    const c = await f.domain.addUserComment({ taskId: f.task.id, userId: f.user.id, body: "记一笔" });
    expect(c.author).toBe("user");
    expect(c.consumedByRunId).toBeNull();

    const list = await listComments(f.db, f.task.id);
    expect(list.some((x) => x.body === "记一笔")).toBe(true);

    const task = await getTask(f.db, f.task.id);
    expect(task!.state).toBe("done"); // inert — no transition

    expect(sub).toHaveBeenCalledWith(
      expect.objectContaining({ t: "task-comment", kind: "created" }),
    );
    expect(await listTaskRuns(f.db, f.task.id)).toEqual([]); // no run started
    await f.close();
  });

  it("deleteUserComment removes an un-consumed user comment", async () => {
    const f = await seed();
    const c = await f.domain.addUserComment({ taskId: f.task.id, userId: f.user.id, body: "x" });
    await f.domain.deleteUserComment(c.id);
    expect(await listComments(f.db, f.task.id)).toEqual([]);
    await f.close();
  });

  it("refuses to delete a worker comment", async () => {
    const f = await seed();
    const worker = await insertComment(f.db, {
      taskId: f.task.id,
      author: "worker",
      body: "handoff",
      state: "done",
    });
    await expect(f.domain.deleteUserComment(worker.id)).rejects.toThrow();
    await f.close();
  });

  it("refuses to delete a consumed comment", async () => {
    const f = await seed();
    const session = await openRunnerSession(f.db, {
      threadId: f.thread.id,
      hostId: f.host.hostId,
      adapter: "claude-code",
    });
    const run = await createTaskRun(f.db, {
      taskId: f.task.id,
      runnerSessionId: session.id,
      attemptNumber: 1,
      startedAt: new Date(),
    });
    const c = await insertComment(f.db, {
      taskId: f.task.id,
      author: "user",
      body: "already sent",
      state: "queued",
      authorUserId: f.user.id,
    });
    const { markCommentsConsumed } = await import("../../db/task-comments.js");
    await markCommentsConsumed(f.db, [c.id], run.id);
    await expect(f.domain.deleteUserComment(c.id)).rejects.toThrow();
    await f.close();
  });
});
