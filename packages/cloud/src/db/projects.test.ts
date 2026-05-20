import { describe, it, expect } from "vitest";
import { makeTestDb } from "./test-db.js";
import { findOrCreateUserByEmail } from "./users.js";
import { createHost } from "./hosts.js";
import { createThread } from "./threads.js";
import { openRunnerSession } from "./sessions.js";
import {
  createProject,
  listProjects,
  getProject,
  archiveProject,
  updateProject,
  createTask,
  listTasksByProject,
  getTask,
  updateTaskState,
  listTaskRuns,
  createTaskRun,
  deleteTask,
  deleteProject,
  getProjectByThreadId,
} from "./projects.js";

async function seedUserAndHost(email = "seed@x.com") {
  const { db, close } = await makeTestDb();
  const u = await findOrCreateUserByEmail(db, email);
  const host = await createHost(db, { userId: u.id, tenantId: u.tenantId, name: "host-1" });
  return { db, close, user: u, host };
}

describe("projects.createTask hostId override", () => {
  it("persists a per-task hostId when provided, null otherwise", async () => {
    const { db, close, user, host } = await seedUserAndHost();
    const project = await createProject(db, {
      tenantId: user.tenantId, userId: user.id, name: "P",
      repoPath: "/repos/p", defaultHostId: host.hostId,
    });
    const pinned = await createTask(db, { projectId: project.id, title: "pinned", hostId: host.hostId });
    const unpinned = await createTask(db, { projectId: project.id, title: "unpinned" });
    expect(pinned.hostId).toBe(host.hostId);
    expect(unpinned.hostId).toBeNull();
    await close();
  });
});

describe("projects.createProject + listProjects", () => {
  it("creates a project with defaults applied", async () => {
    const { db, close, user, host } = await seedUserAndHost();
    const p = await createProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "MyApp",
      repoPath: "/repos/myapp",
      defaultHostId: host.hostId,
    });
    expect(p.name).toBe("MyApp");
    expect(p.mergePolicy).toBe("require-review");
    expect(p.concurrencyLimit).toBe(2);
    expect(p.archivedAt).toBeNull();
    expect(p.description).toBeNull();
    await close();
  });

  it("respects explicit mergePolicy + concurrencyLimit + testCommand", async () => {
    const { db, close, user, host } = await seedUserAndHost();
    const p = await createProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "TestPolicyApp",
      repoPath: "/repos/x",
      defaultHostId: host.hostId,
      mergePolicy: "auto-merge-if-tests-pass",
      testCommand: "pnpm test",
      concurrencyLimit: 8,
      systemPrompt: "be terse",
      description: "demo",
    });
    expect(p.mergePolicy).toBe("auto-merge-if-tests-pass");
    expect(p.testCommand).toBe("pnpm test");
    expect(p.concurrencyLimit).toBe(8);
    expect(p.systemPrompt).toBe("be terse");
    expect(p.description).toBe("demo");
    await close();
  });

  it("listProjects returns empty for a user with none", async () => {
    const { db, close, user } = await seedUserAndHost();
    const list = await listProjects(db, { tenantId: user.tenantId, userId: user.id });
    expect(list).toEqual([]);
    await close();
  });

  it("listProjects excludes archived by default and includes when asked", async () => {
    const { db, close, user, host } = await seedUserAndHost();
    const a = await createProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "A",
      repoPath: "/a",
      defaultHostId: host.hostId,
    });
    const b = await createProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "B",
      repoPath: "/b",
      defaultHostId: host.hostId,
    });
    await archiveProject(db, a.id);

    const visible = await listProjects(db, { tenantId: user.tenantId, userId: user.id });
    expect(visible.map((p) => p.id)).toEqual([b.id]);

    const all = await listProjects(db, {
      tenantId: user.tenantId,
      userId: user.id,
      includeArchived: true,
    });
    expect(all.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    await close();
  });
});

describe("projects.getProject + archiveProject + updateProject", () => {
  it("getProject returns null for unknown id", async () => {
    const { db, close } = await seedUserAndHost();
    const missing = await getProject(db, "00000000-0000-0000-0000-000000000000");
    expect(missing).toBeNull();
    await close();
  });

  it("archiveProject sets archivedAt; getProject still finds it", async () => {
    const { db, close, user, host } = await seedUserAndHost();
    const p = await createProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "X",
      repoPath: "/x",
      defaultHostId: host.hostId,
    });
    await archiveProject(db, p.id);
    const after = await getProject(db, p.id);
    expect(after).not.toBeNull();
    expect(after!.archivedAt).not.toBeNull();
    await close();
  });

  it("updateProject patches fields and bumps updatedAt", async () => {
    const { db, close, user, host } = await seedUserAndHost();
    const p = await createProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "X",
      repoPath: "/x",
      defaultHostId: host.hostId,
    });
    const updated = await updateProject(db, p.id, {
      name: "X-renamed",
      mergePolicy: "auto-merge",
      concurrencyLimit: 4,
      description: null,
    });
    expect(updated.name).toBe("X-renamed");
    expect(updated.mergePolicy).toBe("auto-merge");
    expect(updated.concurrencyLimit).toBe(4);
    expect(updated.description).toBeNull();
    await close();
  });

  it("updateProject throws on unknown id", async () => {
    const { db, close } = await seedUserAndHost();
    await expect(
      updateProject(db, "00000000-0000-0000-0000-000000000000", { name: "x" }),
    ).rejects.toThrow();
    await close();
  });
});

describe("projects.createTask + ref allocation", () => {
  async function seedProject() {
    const env = await seedUserAndHost("tasks@x.com");
    const p = await createProject(env.db, {
      tenantId: env.user.tenantId,
      userId: env.user.id,
      name: "TaskApp",
      repoPath: "/t",
      defaultHostId: env.host.hostId,
    });
    return { ...env, project: p };
  }

  it("creates a task with defaults and allocates ref T-1", async () => {
    const { db, close, project } = await seedProject();
    const t = await createTask(db, { projectId: project.id, title: "First" });
    expect(t.ref).toBe("T-1");
    expect(t.state).toBe("queued");
    expect(t.priority).toBe(0);
    expect(t.labels).toEqual([]);
    expect(t.orderIndex).toBe("1");
    await close();
  });

  it("creates multiple tasks with monotonic ref T-1, T-2, T-3", async () => {
    const { db, close, project } = await seedProject();
    const t1 = await createTask(db, { projectId: project.id, title: "a" });
    const t2 = await createTask(db, { projectId: project.id, title: "b" });
    const t3 = await createTask(db, { projectId: project.id, title: "c" });
    expect([t1.ref, t2.ref, t3.ref]).toEqual(["T-1", "T-2", "T-3"]);
    await close();
  });

  it("respects explicit priority + labels + adapter + orderIndex", async () => {
    const { db, close, project } = await seedProject();
    const t = await createTask(db, {
      projectId: project.id,
      title: "Custom",
      priority: 2,
      labels: ["frontend", "urgent"],
      adapter: "codex",
      orderIndex: "1.5",
    });
    expect(t.priority).toBe(2);
    expect(t.labels).toEqual(["frontend", "urgent"]);
    expect(t.adapter).toBe("codex");
    expect(t.orderIndex).toBe("1.5");
    await close();
  });
});

describe("projects.listTasksByProject + getTask", () => {
  it("listTasksByProject returns empty for a fresh project", async () => {
    const { db, close, user, host } = await seedUserAndHost();
    const p = await createProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "Empty",
      repoPath: "/e",
      defaultHostId: host.hostId,
    });
    expect(await listTasksByProject(db, p.id)).toEqual([]);
    await close();
  });

  it("listTasksByProject returns all created tasks", async () => {
    const { db, close, user, host } = await seedUserAndHost();
    const p = await createProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "P",
      repoPath: "/p",
      defaultHostId: host.hostId,
    });
    await createTask(db, { projectId: p.id, title: "a" });
    await createTask(db, { projectId: p.id, title: "b" });
    const list = await listTasksByProject(db, p.id);
    expect(list.map((t) => t.title).sort()).toEqual(["a", "b"]);
    await close();
  });

  it("getTask returns null for unknown id", async () => {
    const { db, close } = await seedUserAndHost();
    expect(await getTask(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
    await close();
  });
});

describe("projects.updateTaskState", () => {
  it("queued → running with host+worktree fields populated", async () => {
    const { db, close, user, host } = await seedUserAndHost();
    const p = await createProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "P",
      repoPath: "/p",
      defaultHostId: host.hostId,
    });
    const t = await createTask(db, { projectId: p.id, title: "x" });
    const moved = await updateTaskState(db, t.id, "running", {
      hostId: host.hostId,
      worktreePath: "/p/.wt/x",
      branchName: "task/t-1",
      startedAt: new Date(),
    });
    expect(moved.state).toBe("running");
    expect(moved.hostId).toBe(host.hostId);
    expect(moved.worktreePath).toBe("/p/.wt/x");
    expect(moved.branchName).toBe("task/t-1");
    expect(moved.startedAt).not.toBeNull();
    await close();
  });

  it("running → needs-input with needsInputWhat populated, then cleared on resume", async () => {
    const { db, close, user, host } = await seedUserAndHost();
    const p = await createProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "P",
      repoPath: "/p",
      defaultHostId: host.hostId,
    });
    const t = await createTask(db, { projectId: p.id, title: "x" });
    await updateTaskState(db, t.id, "needs-input", { needsInputWhat: "context or redux?" });
    const stalled = await getTask(db, t.id);
    expect(stalled!.state).toBe("needs-input");
    expect(stalled!.needsInputWhat).toBe("context or redux?");

    await updateTaskState(db, t.id, "running", { needsInputWhat: null });
    const resumed = await getTask(db, t.id);
    expect(resumed!.state).toBe("running");
    expect(resumed!.needsInputWhat).toBeNull();
    await close();
  });

  it("updateTaskState throws on unknown task", async () => {
    const { db, close } = await seedUserAndHost();
    await expect(
      updateTaskState(db, "00000000-0000-0000-0000-000000000000", "done"),
    ).rejects.toThrow();
    await close();
  });
});

describe("projects.listTaskRuns + createTaskRun", () => {
  it("listTaskRuns is empty before any run", async () => {
    const { db, close, user, host } = await seedUserAndHost();
    const p = await createProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "P",
      repoPath: "/p",
      defaultHostId: host.hostId,
    });
    const t = await createTask(db, { projectId: p.id, title: "x" });
    expect(await listTaskRuns(db, t.id)).toEqual([]);
    await close();
  });

  it("createTaskRun then list returns runs in attemptNumber order", async () => {
    const { db, close, user, host } = await seedUserAndHost();
    const p = await createProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "P",
      repoPath: "/p",
      defaultHostId: host.hostId,
    });
    const t = await createTask(db, { projectId: p.id, title: "x" });

    // Need a runner_sessions row; create a fake thread + session.
    const thread = await createThread(db, { userId: user.id, tenantId: user.tenantId });
    const s1 = await openRunnerSession(db, {
      threadId: thread.id,
      hostId: host.hostId,
      adapter: "claude-code",
    });
    const s2 = await openRunnerSession(db, {
      threadId: thread.id,
      hostId: host.hostId,
      adapter: "claude-code",
    });

    await createTaskRun(db, {
      taskId: t.id,
      runnerSessionId: s1.id,
      attemptNumber: 1,
      startedAt: new Date("2026-05-19T00:00:00Z"),
    });
    await createTaskRun(db, {
      taskId: t.id,
      runnerSessionId: s2.id,
      attemptNumber: 2,
      startedAt: new Date("2026-05-19T01:00:00Z"),
    });

    const runs = await listTaskRuns(db, t.id);
    expect(runs.map((r) => r.attemptNumber)).toEqual([1, 2]);
    expect(runs[0]!.runnerSessionId).toBe(s1.id);
    expect(runs[1]!.runnerSessionId).toBe(s2.id);
    await close();
  });
});

describe("projects.deleteTask + deleteProject + getProjectByThreadId", () => {
  it("deleteTask removes the row", async () => {
    const { db, close, user, host } = await seedUserAndHost();
    const project = await createProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "P",
      repoPath: "/tmp/p",
      defaultHostId: host.hostId,
    });
    const task = await createTask(db, { projectId: project.id, title: "t" });
    await deleteTask(db, task.id);
    expect(await getTask(db, task.id)).toBeNull();
    await close();
  });

  it("deleteProject cascades tasks and removes project", async () => {
    const { db, close, user, host } = await seedUserAndHost();
    const project = await createProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "P",
      repoPath: "/tmp/p",
      defaultHostId: host.hostId,
    });
    const task = await createTask(db, { projectId: project.id, title: "t" });
    await deleteProject(db, project.id);
    expect(await getProject(db, project.id)).toBeNull();
    expect(await getTask(db, task.id)).toBeNull();
    await close();
  });

  it("getProjectByThreadId finds the project linked via thread_id", async () => {
    const { db, close } = await seedUserAndHost();
    expect(
      await getProjectByThreadId(db, "00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
    await close();
  });
});
