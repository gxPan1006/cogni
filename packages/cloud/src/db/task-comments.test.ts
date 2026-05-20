import { describe, it, expect } from "vitest";
import { makeTestDb } from "./test-db.js";
import { findOrCreateUserByEmail } from "./users.js";
import { createHost } from "./hosts.js";
import { createThread, appendMessage } from "./threads.js";
import { openRunnerSession } from "./sessions.js";
import { createProject, createTask, createTaskRun } from "./projects.js";
import {
  insertComment,
  listComments,
  getComment,
  deleteComment,
  gatherUnconsumedUserComments,
  markCommentsConsumed,
  getLatestAssistantMessage,
} from "./task-comments.js";

async function seed(email = "tc@x.com") {
  const { db, close } = await makeTestDb();
  const user = await findOrCreateUserByEmail(db, email);
  const host = await createHost(db, { userId: user.id, tenantId: user.tenantId, name: "h1" });
  const project = await createProject(db, {
    tenantId: user.tenantId, userId: user.id, name: "P",
    repoPath: "/repos/p", defaultHostId: host.hostId,
  });
  const thread = await createThread(db, { userId: user.id, tenantId: user.tenantId });
  const task = await createTask(db, { projectId: project.id, title: "T", executionThreadId: thread.id });
  return { db, close, user, host, project, thread, task };
}

async function makeRun(db: Awaited<ReturnType<typeof seed>>["db"], threadId: string, hostId: string, taskId: string) {
  const session = await openRunnerSession(db, { threadId, hostId, adapter: "claude-code" });
  const run = await createTaskRun(db, {
    taskId, runnerSessionId: session.id, attemptNumber: 1, startedAt: new Date(),
  });
  return run;
}

describe("task-comments db", () => {
  it("insert + list returns chronological feed", async () => {
    const { db, close, task, user } = await seed();
    await insertComment(db, { taskId: task.id, author: "user", body: "first", state: "done", authorUserId: user.id });
    await insertComment(db, { taskId: task.id, author: "worker", body: "note", state: "done" });
    const list = await listComments(db, task.id);
    expect(list.map((c) => c.body)).toEqual(["first", "note"]);
    expect(list[0]!.author).toBe("user");
    await close();
  });

  it("gatherUnconsumed returns only unconsumed user comments oldest-first", async () => {
    const { db, close, task, user } = await seed("tc2@x.com");
    await insertComment(db, { taskId: task.id, author: "user", body: "u1", state: "done", authorUserId: user.id });
    await insertComment(db, { taskId: task.id, author: "worker", body: "w1", state: "done" });
    const got = await gatherUnconsumedUserComments(db, task.id);
    expect(got.map((c) => c.body)).toEqual(["u1"]);
    await close();
  });

  it("markCommentsConsumed stamps the run id and excludes them next time", async () => {
    const { db, close, task, thread, host, user } = await seed("tc3@x.com");
    const c = await insertComment(db, { taskId: task.id, author: "user", body: "u1", state: "done", authorUserId: user.id });
    const run = await makeRun(db, thread.id, host.hostId, task.id);
    await markCommentsConsumed(db, [c.id], run.id);
    expect(await gatherUnconsumedUserComments(db, task.id)).toEqual([]);
    const after = await getComment(db, c.id);
    expect(after!.consumedByRunId).toBe(run.id);
    await close();
  });

  it("deleteComment removes the row", async () => {
    const { db, close, task, user } = await seed("tc4@x.com");
    const c = await insertComment(db, { taskId: task.id, author: "user", body: "x", state: "done", authorUserId: user.id });
    await deleteComment(db, c.id);
    expect(await listComments(db, task.id)).toEqual([]);
    await close();
  });

  it("getLatestAssistantMessage returns the newest assistant content", async () => {
    const { db, close, task, thread } = await seed("tc5@x.com");
    await appendMessage(db, { threadId: thread.id, role: "user", content: "做个贪吃蛇" });
    await appendMessage(db, { threadId: thread.id, role: "assistant", content: "已完成: 写了 snake.html" });
    expect(await getLatestAssistantMessage(db, thread.id)).toBe("已完成: 写了 snake.html");
    expect(task.executionThreadId).toBe(thread.id);
    await close();
  });
});
