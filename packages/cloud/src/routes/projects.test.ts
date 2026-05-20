import { describe, it, expect, vi } from "vitest";
import { makeTestDb } from "../db/test-db.js";
import { findOrCreateUserByEmail } from "../db/users.js";
import { createHost } from "../db/hosts.js";
import { createAuthSession } from "../db/auth-sessions.js";
import { createProject as dbCreateProject, createTask as dbCreateTask } from "../db/projects.js";
import { HostRouter } from "../host-router.js";
import { ClientHub } from "../client-hub.js";
import { ChatDomain } from "../domains/chat.js";
import { FakeTransport } from "../email/transport.js";
import { makeAuth } from "../auth.js";
import { createServer, type ProjectDomain } from "../server.js";
import type { Project, ProjectTask } from "@cogni/contract";

/**
 * In-process rig for SP-3 routes/projects.ts tests. Spins the full Hono
 * app against pglite + fakes, with a vitest mock standing in for Track B's
 * ProjectDomain class. The mock returns just enough shape that each route
 * can format its response — actual domain behavior is Track B's concern.
 */
function makeProjectDomainMock(): {
  domain: ProjectDomain;
  fns: {
    createProject: ReturnType<typeof vi.fn>;
    updateProject: ReturnType<typeof vi.fn>;
    archiveProject: ReturnType<typeof vi.fn>;
    createTask: ReturnType<typeof vi.fn>;
    replyToTask: ReturnType<typeof vi.fn>;
    acceptTask: ReturnType<typeof vi.fn>;
    rejectTask: ReturnType<typeof vi.fn>;
    retryTask: ReturnType<typeof vi.fn>;
    cancelTask: ReturnType<typeof vi.fn>;
    deleteTask: ReturnType<typeof vi.fn>;
    deleteProject: ReturnType<typeof vi.fn>;
    getTaskDiff: ReturnType<typeof vi.fn>;
    fsBrowse: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
} {
  const fns = {
    createProject: vi.fn(),
    updateProject: vi.fn(),
    archiveProject: vi.fn(),
    createTask: vi.fn(),
    replyToTask: vi.fn(),
    acceptTask: vi.fn(),
    rejectTask: vi.fn(),
    retryTask: vi.fn(),
    cancelTask: vi.fn(),
    deleteTask: vi.fn(),
    deleteProject: vi.fn(),
    getTaskDiff: vi.fn(),
    fsBrowse: vi.fn(),
    dispose: vi.fn(),
  };
  return { domain: fns as unknown as ProjectDomain, fns };
}

async function setup() {
  const { db, close } = await makeTestDb();
  const user = await findOrCreateUserByEmail(db, "alice@x.com");
  const auth = makeAuth({
    jwtSecret: "test-secret-test-secret-test-sec",
    google: { clientId: "x", clientSecret: "y", redirectUri: "http://x/cb" },
  });
  const session = await createAuthSession(db, {
    userId: user.id,
    deviceName: "test rig",
  });
  const token = await auth.issueToken({
    userId: user.id,
    tenantId: user.tenantId,
    sessionId: session.id,
  });
  const hosts = new HostRouter();
  const clients = new ClientHub();
  const chat = new ChatDomain(db, hosts, clients);
  const { domain: projectDomain, fns } = makeProjectDomainMock();

  // Pre-create a host the caller owns — most project flows need one.
  const host = await createHost(db, {
    userId: user.id,
    tenantId: user.tenantId,
    name: "Mac",
  });

  const deps = {
    db,
    auth,
    hosts,
    clients,
    chat,
    projectDomain,
    emailTransport: new FakeTransport(),
    magicLinkTtlMinutes: 15,
    publicUrl: "http://localhost",
    webUrl: "https://chat.ai-cognit.com",
  };
  const { app } = createServer(deps);

  async function req(path: string, init: RequestInit = {}) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    return app.request(path, { ...init, headers });
  }

  return { db, user, host, deps, fns, app, req, close };
}

// ─── Projects ───────────────────────────────────────────────────────────────

describe("GET /api/projects", () => {
  it("returns the user's projects, defaults to active only", async () => {
    const { db, user, host, req, close } = await setup();
    await dbCreateProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "Alpha",
      repoPath: "/repos/alpha",
      defaultHostId: host.hostId,
    });
    const res = await req("/api/projects");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Project[];
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe("Alpha");
    await close();
  });

  it("excludes other users' projects", async () => {
    const { db, req, close } = await setup();
    const bob = await findOrCreateUserByEmail(db, "bob@x.com");
    const bobHost = await createHost(db, {
      userId: bob.id,
      tenantId: bob.tenantId,
      name: "Bob's Mac",
    });
    await dbCreateProject(db, {
      tenantId: bob.tenantId,
      userId: bob.id,
      name: "Bob's project",
      repoPath: "/repos/bob",
      defaultHostId: bobHost.hostId,
    });
    const res = await req("/api/projects");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    await close();
  });
});

describe("POST /api/projects", () => {
  it("delegates to projectDomain.createProject and returns 201", async () => {
    const { user, host, fns, req, close } = await setup();
    const fakeProject: Project = {
      id: "fake-project-id",
      tenantId: user.tenantId,
      userId: user.id,
      name: "Newco",
      description: null,
      repoPath: "/repos/newco",
      defaultHostId: host.hostId,
      threadId: null,
      mergePolicy: "require-review",
      testCommand: null,
      concurrencyLimit: 2,
      systemPrompt: null,
      archivedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fns.createProject.mockResolvedValue(fakeProject);

    const res = await req("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Newco",
        repoPath: "/repos/newco",
        defaultHostId: host.hostId,
      }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(fakeProject);
    expect(fns.createProject).toHaveBeenCalledTimes(1);
    expect(fns.createProject.mock.calls[0]![0]).toMatchObject({
      tenantId: user.tenantId,
      userId: user.id,
      name: "Newco",
      repoPath: "/repos/newco",
      defaultHostId: host.hostId,
    });
    await close();
  });

  it("400 on missing required fields", async () => {
    const { req, close } = await setup();
    const res = await req("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Newco" }), // missing repoPath + defaultHostId
    });
    expect(res.status).toBe(400);
    // Yield once so the fire-and-forget touchAuthSession() in /api/* middleware
    // completes against pglite before close() — early-bailing handlers
    // (like this one) finish before the async touch lands and would otherwise
    // race with PGlite teardown.
    await new Promise((r) => setImmediate(r));
    await close();
  });

  it("404 if defaultHostId doesn't belong to caller", async () => {
    const { db, fns, req, close } = await setup();
    const bob = await findOrCreateUserByEmail(db, "bob@x.com");
    const bobHost = await createHost(db, {
      userId: bob.id,
      tenantId: bob.tenantId,
      name: "Bob's Mac",
    });
    const res = await req("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Newco",
        repoPath: "/repos/newco",
        defaultHostId: bobHost.hostId,
      }),
    });
    expect(res.status).toBe(404);
    expect(fns.createProject).not.toHaveBeenCalled();
    await close();
  });
});

describe("GET /api/projects/:id", () => {
  it("returns project + taskCount", async () => {
    const { db, user, host, req, close } = await setup();
    const project = await dbCreateProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "Alpha",
      repoPath: "/repos/alpha",
      defaultHostId: host.hostId,
    });
    await dbCreateTask(db, { projectId: project.id, title: "First" });
    const res = await req(`/api/projects/${project.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { project: Project; taskCount: number };
    expect(body.project.id).toBe(project.id);
    expect(body.taskCount).toBe(1);
    await close();
  });

  it("404 cross-user", async () => {
    const { db, req, close } = await setup();
    const bob = await findOrCreateUserByEmail(db, "bob@x.com");
    const bobHost = await createHost(db, {
      userId: bob.id,
      tenantId: bob.tenantId,
      name: "Bob",
    });
    const bobProject = await dbCreateProject(db, {
      tenantId: bob.tenantId,
      userId: bob.id,
      name: "Bob",
      repoPath: "/repos/bob",
      defaultHostId: bobHost.hostId,
    });
    const res = await req(`/api/projects/${bobProject.id}`);
    expect(res.status).toBe(404);
    await close();
  });
});

describe("PATCH /api/projects/:id", () => {
  it("delegates to projectDomain.updateProject", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const project = await dbCreateProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "Alpha",
      repoPath: "/repos/alpha",
      defaultHostId: host.hostId,
    });
    fns.updateProject.mockResolvedValue({ ...project, name: "Alpha renamed" });
    const res = await req(`/api/projects/${project.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Alpha renamed" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Project).name).toBe("Alpha renamed");
    expect(fns.updateProject).toHaveBeenCalledWith(project.id, { name: "Alpha renamed" });
    await close();
  });
});

describe("POST /api/projects/:id/archive", () => {
  it("delegates to projectDomain.archiveProject", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const project = await dbCreateProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "Alpha",
      repoPath: "/repos/alpha",
      defaultHostId: host.hostId,
    });
    fns.archiveProject.mockResolvedValue(undefined);
    const res = await req(`/api/projects/${project.id}/archive`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fns.archiveProject).toHaveBeenCalledWith(project.id);
    await close();
  });

  it("404 cross-user", async () => {
    const { db, req, close } = await setup();
    const bob = await findOrCreateUserByEmail(db, "bob@x.com");
    const bobHost = await createHost(db, {
      userId: bob.id,
      tenantId: bob.tenantId,
      name: "Bob",
    });
    const bobProject = await dbCreateProject(db, {
      tenantId: bob.tenantId,
      userId: bob.id,
      name: "Bob",
      repoPath: "/repos/bob",
      defaultHostId: bobHost.hostId,
    });
    const res = await req(`/api/projects/${bobProject.id}/archive`, { method: "POST" });
    expect(res.status).toBe(404);
    await close();
  });
});

// ─── Tasks (project-scoped) ────────────────────────────────────────────────

describe("GET /api/projects/:id/tasks", () => {
  it("returns the project's tasks", async () => {
    const { db, user, host, req, close } = await setup();
    const project = await dbCreateProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "Alpha",
      repoPath: "/repos/alpha",
      defaultHostId: host.hostId,
    });
    await dbCreateTask(db, { projectId: project.id, title: "T1" });
    await dbCreateTask(db, { projectId: project.id, title: "T2" });
    const res = await req(`/api/projects/${project.id}/tasks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectTask[];
    expect(body).toHaveLength(2);
    await close();
  });
});

describe("POST /api/projects/:id/tasks", () => {
  it("delegates to projectDomain.createTask", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const project = await dbCreateProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "Alpha",
      repoPath: "/repos/alpha",
      defaultHostId: host.hostId,
    });
    const fakeTask: ProjectTask = {
      id: "task-id",
      projectId: project.id,
      ref: "T-1",
      title: "Hello",
      description: null,
      state: "queued",
      priority: 0,
      labels: [],
      orderIndex: "1",
      hostId: null,
      adapter: null,
      worktreePath: null,
      branchName: null,
      executionThreadId: null,
      retries: 0,
      maxRetries: 3,
      needsInputWhat: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    };
    fns.createTask.mockResolvedValue(fakeTask);
    const res = await req(`/api/projects/${project.id}/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Hello", priority: 2 }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(fakeTask);
    expect(fns.createTask).toHaveBeenCalledWith({
      projectId: project.id,
      title: "Hello",
      description: undefined,
      priority: 2,
      labels: undefined,
      adapter: undefined,
      hostId: undefined,
    });
    await close();
  });

  it("passes a per-task hostId override the caller owns", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const project = await dbCreateProject(db, {
      tenantId: user.tenantId, userId: user.id, name: "Alpha",
      repoPath: "/repos/alpha", defaultHostId: host.hostId,
    });
    fns.createTask.mockResolvedValue({ id: "t" } as unknown as ProjectTask);
    const res = await req(`/api/projects/${project.id}/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Hello", hostId: host.hostId }),
    });
    expect(res.status).toBe(201);
    expect(fns.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: host.hostId }),
    );
    await close();
  });

  it("404 when the per-task hostId override is not owned by the caller", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const project = await dbCreateProject(db, {
      tenantId: user.tenantId, userId: user.id, name: "Alpha",
      repoPath: "/repos/alpha", defaultHostId: host.hostId,
    });
    const res = await req(`/api/projects/${project.id}/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Hello", hostId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(404);
    expect(fns.createTask).not.toHaveBeenCalled();
    await close();
  });
});

// ─── Task actions ──────────────────────────────────────────────────────────

async function makeProjectAndTask(
  db: Awaited<ReturnType<typeof setup>>["db"],
  user: { id: string; tenantId: string },
  hostId: string,
  state: ProjectTask["state"],
): Promise<{ projectId: string; task: ProjectTask }> {
  const project = await dbCreateProject(db, {
    tenantId: user.tenantId,
    userId: user.id,
    name: "Alpha",
    repoPath: "/repos/alpha",
    defaultHostId: hostId,
  });
  const task = await dbCreateTask(db, {
    projectId: project.id,
    title: "T",
    state,
  });
  return { projectId: project.id, task };
}

describe("GET /api/tasks/:taskId", () => {
  it("returns task + runs", async () => {
    const { db, user, host, req, close } = await setup();
    const { task } = await makeProjectAndTask(db, user, host.hostId, "queued");
    const res = await req(`/api/tasks/${task.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: ProjectTask; runs: unknown[] };
    expect(body.task.id).toBe(task.id);
    expect(body.runs).toEqual([]);
    await close();
  });

  it("404 cross-user", async () => {
    const { db, req, close } = await setup();
    const bob = await findOrCreateUserByEmail(db, "bob@x.com");
    const bobHost = await createHost(db, {
      userId: bob.id,
      tenantId: bob.tenantId,
      name: "Bob",
    });
    const { task } = await makeProjectAndTask(db, bob, bobHost.hostId, "queued");
    const res = await req(`/api/tasks/${task.id}`);
    expect(res.status).toBe(404);
    await close();
  });
});

describe("POST /api/tasks/:taskId/reply", () => {
  it("calls projectDomain.replyToTask when state=needs-input", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const { task } = await makeProjectAndTask(db, user, host.hostId, "needs-input");
    fns.replyToTask.mockResolvedValue(undefined);
    const res = await req(`/api/tasks/${task.id}/reply`, {
      method: "POST",
      body: JSON.stringify({ content: "use sqlite" }),
    });
    expect(res.status).toBe(200);
    // B's replyToTask takes a single object {taskId,userId,content,sourceClientId}
    // (rather than positional args) because it reuses ChatDomain.handleClientSend
    // under the hood. The HTTP route adapts the call shape; assertions follow suit.
    expect(fns.replyToTask).toHaveBeenCalledWith({
      taskId: task.id,
      userId: user.id,
      content: "use sqlite",
      sourceClientId: "rest:reply",
    });
    await close();
  });

  it("409 invalid-state when task isn't in needs-input", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const { task } = await makeProjectAndTask(db, user, host.hostId, "running");
    const res = await req(`/api/tasks/${task.id}/reply`, {
      method: "POST",
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "invalid-state", currentState: "running" });
    expect(fns.replyToTask).not.toHaveBeenCalled();
    await close();
  });
});

describe("POST /api/tasks/:taskId/accept", () => {
  it("calls acceptTask when state=reviewing", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const { task } = await makeProjectAndTask(db, user, host.hostId, "reviewing");
    fns.acceptTask.mockResolvedValue(undefined);
    const res = await req(`/api/tasks/${task.id}/accept`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(fns.acceptTask).toHaveBeenCalledWith(task.id);
    await close();
  });

  it("409 when task is queued (not reviewing)", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const { task } = await makeProjectAndTask(db, user, host.hostId, "queued");
    const res = await req(`/api/tasks/${task.id}/accept`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(fns.acceptTask).not.toHaveBeenCalled();
    await close();
  });
});

describe("POST /api/tasks/:taskId/reject", () => {
  it("calls rejectTask when state=reviewing", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const { task } = await makeProjectAndTask(db, user, host.hostId, "reviewing");
    fns.rejectTask.mockResolvedValue(undefined);
    const res = await req(`/api/tasks/${task.id}/reject`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(fns.rejectTask).toHaveBeenCalledWith(task.id);
    await close();
  });
});

describe("POST /api/tasks/:taskId/retry", () => {
  it("calls retryTask when state=failed", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const { task } = await makeProjectAndTask(db, user, host.hostId, "failed");
    fns.retryTask.mockResolvedValue(undefined);
    const res = await req(`/api/tasks/${task.id}/retry`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(fns.retryTask).toHaveBeenCalledWith(task.id);
    await close();
  });

  it("calls retryTask when state=done (re-run on completed work)", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const { task } = await makeProjectAndTask(db, user, host.hostId, "done");
    fns.retryTask.mockResolvedValue(undefined);
    const res = await req(`/api/tasks/${task.id}/retry`, { method: "POST" });
    expect(res.status).toBe(200);
    await close();
  });

  it("409 when task is running", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const { task } = await makeProjectAndTask(db, user, host.hostId, "running");
    const res = await req(`/api/tasks/${task.id}/retry`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(fns.retryTask).not.toHaveBeenCalled();
    await close();
  });
});

describe("POST /api/tasks/:taskId/cancel", () => {
  it("calls cancelTask for non-terminal states", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const { task } = await makeProjectAndTask(db, user, host.hostId, "running");
    fns.cancelTask.mockResolvedValue(undefined);
    const res = await req(`/api/tasks/${task.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(fns.cancelTask).toHaveBeenCalledWith(task.id);
    await close();
  });

  it("409 on terminal state (done)", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const { task } = await makeProjectAndTask(db, user, host.hostId, "done");
    const res = await req(`/api/tasks/${task.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(fns.cancelTask).not.toHaveBeenCalled();
    await close();
  });
});

describe("GET /api/tasks/:taskId/diff", () => {
  it("proxies to projectDomain.getTaskDiff", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const { task } = await makeProjectAndTask(db, user, host.hostId, "reviewing");
    fns.getTaskDiff.mockResolvedValue({
      diff: "diff --git a/foo b/foo\n+hello\n",
      stats: { files: 1, additions: 1, deletions: 0 },
    });
    const res = await req(`/api/tasks/${task.id}/diff`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { diff: string; stats: unknown };
    expect(body.diff).toContain("diff --git");
    expect(fns.getTaskDiff).toHaveBeenCalledWith(task.id);
    await close();
  });

  it("503 when domain reports host-offline", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const { task } = await makeProjectAndTask(db, user, host.hostId, "reviewing");
    const err = Object.assign(new Error("host offline"), { code: "host-offline" });
    fns.getTaskDiff.mockRejectedValue(err);
    const res = await req(`/api/tasks/${task.id}/diff`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "host-offline" });
    await close();
  });
});

// ─── fs-browse ─────────────────────────────────────────────────────────────

describe("POST /api/hosts/:hostId/fs-browse", () => {
  it("proxies to projectDomain.fsBrowse", async () => {
    const { host, fns, req, close } = await setup();
    fns.fsBrowse.mockResolvedValue({
      entries: [{ name: "repos", type: "dir" }],
      cwd: "/Users/alice",
    });
    const res = await req(`/api/hosts/${host.hostId}/fs-browse`, {
      method: "POST",
      body: JSON.stringify({ path: "/Users/alice" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cwd: string; entries: unknown[] };
    expect(body.cwd).toBe("/Users/alice");
    expect(fns.fsBrowse).toHaveBeenCalledWith(host.hostId, "/Users/alice");
    await close();
  });

  it("404 on cross-user host", async () => {
    const { db, fns, req, close } = await setup();
    const bob = await findOrCreateUserByEmail(db, "bob@x.com");
    const bobHost = await createHost(db, {
      userId: bob.id,
      tenantId: bob.tenantId,
      name: "Bob",
    });
    const res = await req(`/api/hosts/${bobHost.hostId}/fs-browse`, {
      method: "POST",
      body: JSON.stringify({ path: "/" }),
    });
    expect(res.status).toBe(404);
    expect(fns.fsBrowse).not.toHaveBeenCalled();
    await close();
  });
});

// ─── Auth ──────────────────────────────────────────────────────────────────

describe("auth", () => {
  it("401 without Bearer token", async () => {
    const { app, close } = await setup();
    const res = await app.request("/api/projects");
    expect(res.status).toBe(401);
    await close();
  });
});

// ─── SP-4 DELETE routes ──────────────────────────────────────────────────────

describe("DELETE /api/tasks/:taskId", () => {
  it("removes the task (200) and delegates to projectDomain.deleteTask", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const project = await dbCreateProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "P",
      repoPath: "/repos/p",
      defaultHostId: host.hostId,
    });
    const task = await dbCreateTask(db, { projectId: project.id, title: "t" });
    fns.deleteTask.mockResolvedValue(undefined);
    const res = await req(`/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fns.deleteTask).toHaveBeenCalledWith(task.id);
    await close();
  });

  it("404 for another user's task", async () => {
    const { db, fns, req, close } = await setup();
    const bob = await findOrCreateUserByEmail(db, "bob@x.com");
    const bobHost = await createHost(db, { userId: bob.id, tenantId: bob.tenantId, name: "Bob" });
    const bobProject = await dbCreateProject(db, {
      tenantId: bob.tenantId,
      userId: bob.id,
      name: "Bob",
      repoPath: "/repos/bob",
      defaultHostId: bobHost.hostId,
    });
    const bobTask = await dbCreateTask(db, { projectId: bobProject.id, title: "t" });
    const res = await req(`/api/tasks/${bobTask.id}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(fns.deleteTask).not.toHaveBeenCalled();
    await close();
  });
});

describe("DELETE /api/projects/:id", () => {
  it("removes the project (200) and delegates to projectDomain.deleteProject", async () => {
    const { db, user, host, fns, req, close } = await setup();
    const project = await dbCreateProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "P",
      repoPath: "/repos/p",
      defaultHostId: host.hostId,
    });
    fns.deleteProject.mockResolvedValue(undefined);
    const res = await req(`/api/projects/${project.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fns.deleteProject).toHaveBeenCalledWith(project.id);
    await close();
  });

  it("404 for another user's project", async () => {
    const { db, fns, req, close } = await setup();
    const bob = await findOrCreateUserByEmail(db, "bob@x.com");
    const bobHost = await createHost(db, { userId: bob.id, tenantId: bob.tenantId, name: "Bob" });
    const bobProject = await dbCreateProject(db, {
      tenantId: bob.tenantId,
      userId: bob.id,
      name: "Bob",
      repoPath: "/repos/bob",
      defaultHostId: bobHost.hostId,
    });
    const res = await req(`/api/projects/${bobProject.id}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(fns.deleteProject).not.toHaveBeenCalled();
    await close();
  });
});

// ─── SP-4 Host-token auth ────────────────────────────────────────────────────

describe("Authorization: Host <token>", () => {
  it("lets a registered host act as its owning user", async () => {
    const { db, app, user, host, fns, close } = await setup();
    const project = await dbCreateProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "P",
      repoPath: "/repos/p",
      defaultHostId: host.hostId,
    });
    fns.createTask.mockResolvedValue({ id: "t1", title: "via host" });
    const res = await app.request(`/api/projects/${project.id}/tasks`, {
      method: "POST",
      headers: {
        Authorization: `Host ${host.registrationToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "via host" }),
    });
    expect(res.status).toBe(201);
    expect(fns.createTask).toHaveBeenCalledTimes(1);
    await close();
  });

  it("rejects an unknown Host token with 401", async () => {
    const { app, close } = await setup();
    const res = await app.request(`/api/projects`, {
      method: "GET",
      headers: { Authorization: "Host nope" },
    });
    expect(res.status).toBe(401);
    await close();
  });
});

// ─── SP-4 orchestrator thread-id endpoints ───────────────────────────────────

describe("GET /api/workspace-thread", () => {
  it("returns a stable workspace thread id across calls", async () => {
    const { req, close } = await setup();
    const a = (await (await req("/api/workspace-thread")).json()) as { threadId: string };
    const b = (await (await req("/api/workspace-thread")).json()) as { threadId: string };
    expect(a.threadId).toBeTruthy();
    expect(a.threadId).toBe(b.threadId);
    await close();
  });
});

describe("GET /api/projects/:id/chat-thread", () => {
  it("returns the project orchestrator thread id", async () => {
    const { db, user, host, req, close } = await setup();
    const project = await dbCreateProject(db, {
      tenantId: user.tenantId,
      userId: user.id,
      name: "P",
      repoPath: "/repos/p",
      defaultHostId: host.hostId,
    });
    const res = await req(`/api/projects/${project.id}/chat-thread`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { threadId: string }).threadId).toBeTruthy();
    await close();
  });

  it("404 for another user's project", async () => {
    const { db, req, close } = await setup();
    const bob = await findOrCreateUserByEmail(db, "bob@x.com");
    const bobHost = await createHost(db, { userId: bob.id, tenantId: bob.tenantId, name: "Bob" });
    const bobProject = await dbCreateProject(db, {
      tenantId: bob.tenantId,
      userId: bob.id,
      name: "Bob",
      repoPath: "/repos/bob",
      defaultHostId: bobHost.hostId,
    });
    const res = await req(`/api/projects/${bobProject.id}/chat-thread`);
    expect(res.status).toBe(404);
    await close();
  });
});
