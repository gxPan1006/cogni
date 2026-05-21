import type { Hono } from "hono";
import { z } from "zod";
import { logger } from "@cogni/shared";
import {
  mergePolicySchema,
  prioritySchema,
  attachmentSchema,
  taskStateSchema,
  type Project,
  type ProjectTask,
  type TaskRun,
} from "@cogni/contract";
import {
  getProject,
  listProjects,
  listTasksByProject,
  getTask,
  listTaskRuns,
} from "../db/projects.js";
import {
  getOrCreateWorkspaceThread,
  getOrCreateProjectThread,
  listOrchestratorThreads,
  createOrchestratorThread,
} from "../db/threads.js";
import { hosts as hostsTable } from "../db/schema.js";
import { eq, and, isNull } from "drizzle-orm";
import { artifactFileResponse, pathUnder } from "./artifact-file.js";
import { relayUpload } from "./upload.js";
import { sendHostRpc } from "./host-ws.js";
import type { ServerDeps } from "../server.js";

/**
 * SP-3 Project domain REST surface.
 *
 * What the user sees (端到端):
 *   • Projects sidebar / list page hits `GET /api/projects` to render the
 *     left-rail "My projects" entries; each row is a card with name +
 *     needs-input badge.
 *   • "New project" modal POSTs `/api/projects` after host pick + repoPath
 *     fill — Cloud writes the row, Track B's domain triggers an optional
 *     `git-init-if-missing` against the host RPC, and the page transitions
 *     to the empty kanban for the new project.
 *   • Kanban board pulls `GET /api/projects/:id/tasks`; cards rendered by
 *     state column. "+ Add task" POSTs `/api/projects/:id/tasks`.
 *   • Card click opens TaskDetail drawer — drawer header pulls
 *     `GET /api/tasks/:taskId` (task + retry runs), "Review" tab pulls
 *     `GET /api/tasks/:taskId/diff`. Footer action buttons:
 *       - state=needs-input → "Send reply" → POST /tasks/:id/reply
 *       - state=reviewing  → "Accept" / "Reject" → POST /tasks/:id/accept|reject
 *       - state=failed     → "Retry" → POST /tasks/:id/retry
 *       - any non-terminal → "Cancel" → POST /tasks/:id/cancel
 *   • New-project flow on web has a "📁 Browse <host>" button that POSTs
 *     `/api/hosts/:hostId/fs-browse {path}` to walk the remote host's FS
 *     for the repoPath picker.
 *
 * Auth: every route requires the `/api/*` Bearer middleware mounted in
 * routes/client.ts. The middleware stashes `claims = {userId, tenantId,
 * sessionId}` on the context. Ownership checks enforce that the project
 * (or task's parent project) belongs to the caller — cross-user reads
 * return 404, not 403, to avoid leaking project-id existence.
 *
 * Error model:
 *   • Resource missing or cross-user: 404 {error:"not found"}
 *   • State precondition fails (e.g. accept on non-reviewing task):
 *     409 {error:"invalid-state", currentState}
 *   • Host offline (domain layer surfaces it): 503 {error:"host-offline"}
 *   • Body validation: 400 {error:"invalid body", details}
 */

// ─── Zod request schemas ────────────────────────────────────────────────────

const createProjectSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  repoPath: z.string().min(1),
  defaultHostId: z.string().uuid(),
  mergePolicy: mergePolicySchema.optional(),
  testCommand: z.string().optional(),
  concurrencyLimit: z.number().int().min(1).max(16).optional(),
  systemPrompt: z.string().optional(),
  pushToRemote: z.boolean().optional(),
  /** Tell the domain to run `git-init-if-missing` after row insert. */
  initGit: z.boolean().optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  defaultHostId: z.string().uuid().optional(),
  mergePolicy: mergePolicySchema.optional(),
  testCommand: z.string().nullable().optional(),
  concurrencyLimit: z.number().int().min(1).max(16).optional(),
  systemPrompt: z.string().nullable().optional(),
  pushToRemote: z.boolean().optional(),
});

const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).optional(),
  priority: prioritySchema.optional(),
  labels: z.array(z.string().min(1).max(40)).max(20).optional(),
  adapter: z.string().optional(),
  /** SP-3+1 per-task host override (must belong to the caller). */
  hostId: z.string().uuid().optional(),
});

const replySchema = z.object({
  content: z.string().min(1).max(20_000),
  /**
   * Files the user attached to this reply. They were already streamed to the
   * task's host via POST /api/tasks/:id/uploads (staged under the task's
   * executionThreadId); naming them here makes the dispatch materialize them
   * into the task's worktree cwd so the runner can read them. Optional +
   * backward compatible — a reply with no attachments omits the field.
   */
  attachments: z.array(attachmentSchema).max(20).optional(),
});

const fsBrowseSchema = z.object({
  path: z.string().optional(),
});

/** Body of POST /api/tasks/:taskId/comments — an inert human note. */
const commentBodySchema = z.object({
  body: z.string().min(1).max(8000),
  parentCommentId: z.string().optional(),
  attachments: z.array(z.object({ name: z.string(), size: z.number().int().min(0) })).optional(),
});

/** Body of PATCH /api/tasks/:taskId/state — the kanban drag target column. */
const moveStateSchema = z.object({ to: taskStateSchema });

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns the project iff it belongs to `userId` + `tenantId` (and isn't
 * archived only when `requireActive=true`). Returns null on miss — caller
 * surfaces a 404 to avoid leaking existence across users.
 */
async function ownedProject(
  deps: ServerDeps,
  projectId: string,
  userId: string,
  tenantId: string,
): Promise<Project | null> {
  const project = await getProject(deps.db, projectId);
  if (!project) return null;
  if (project.userId !== userId || project.tenantId !== tenantId) return null;
  return project;
}

/**
 * Returns the task + its parent project iff the project is owned by the
 * caller. Returns null on any miss — same 404-not-403 pattern.
 */
async function ownedTask(
  deps: ServerDeps,
  taskId: string,
  userId: string,
  tenantId: string,
): Promise<{ task: ProjectTask; project: Project } | null> {
  const task = await getTask(deps.db, taskId);
  if (!task) return null;
  const project = await ownedProject(deps, task.projectId, userId, tenantId);
  if (!project) return null;
  return { task, project };
}

/**
 * Translate ProjectDomain-layer errors into HTTP responses. The domain
 * throws Error subclasses tagged with `.code` so we can route uniformly:
 *   - "invalid-state" → 409 + currentState
 *   - "host-offline"  → 503
 *   - anything else   → 500 (and log)
 */
function domainErrorResponse(
  err: unknown,
): { status: 400 | 409 | 500 | 503; body: Record<string, unknown> } {
  const e = err as { code?: string; message?: string; currentState?: string };
  if (e && typeof e === "object") {
    if (e.code === "invalid-state") {
      return {
        status: 409,
        body: { error: "invalid-state", currentState: e.currentState ?? null },
      };
    }
    if (e.code === "host-offline") {
      return { status: 503, body: { error: "host-offline" } };
    }
    if (e.code === "not-found") {
      // domain may surface "not-found" for race conditions; map to 400 here
      // because we already 404'd on the entry-point ownership check.
      return { status: 400, body: { error: "not found" } };
    }
  }
  logger.error({ err: String(err) }, "projects route domain error");
  return { status: 500, body: { error: "internal" } };
}

/**
 * Confirm a host belongs to the caller before forwarding fs-browse.
 * Mirrors routes/hosts.ts `ownedHost` (kept private there).
 */
async function ownedHost(
  deps: ServerDeps,
  hostId: string,
  userId: string,
): Promise<boolean> {
  const rows = await deps.db
    .select({ id: hostsTable.id })
    .from(hostsTable)
    .where(
      and(
        eq(hostsTable.id, hostId),
        eq(hostsTable.userId, userId),
        isNull(hostsTable.removedAt),
      ),
    )
    .limit(1);
  return !!rows[0];
}

/**
 * Like `ownedHost` but returns the full host row (needed by the projects-root
 * route to re-broadcast host-meta with name/status/lastSeen). null on miss.
 */
async function ownedHostRow(
  deps: ServerDeps,
  hostId: string,
  userId: string,
): Promise<typeof hostsTable.$inferSelect | null> {
  const rows = await deps.db
    .select()
    .from(hostsTable)
    .where(
      and(
        eq(hostsTable.id, hostId),
        eq(hostsTable.userId, userId),
        isNull(hostsTable.removedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ─── Route registration ─────────────────────────────────────────────────────

export function registerProjectsRoutes(app: Hono, deps: ServerDeps): void {
  // ─── Projects ────────────────────────────────────────────────────────────

  app.get("/api/projects", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const includeArchived = c.req.query("includeArchived") === "true";
    const rows = await listProjects(deps.db, {
      tenantId,
      userId,
      includeArchived,
    });
    return c.json(rows);
  });

  // ─── SP-4 orchestrator thread-id endpoints ───────────────────────────────
  // The Workspace Chat bar resolves which thread to subscribe to via these:
  // a stable per-user workspace thread, or a per-project orchestrator thread.

  app.get("/api/workspace-thread", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const t = await getOrCreateWorkspaceThread(deps.db, { userId, tenantId });
    return c.json({ threadId: t.id });
  });

  app.get("/api/projects/:id/chat-thread", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const project = await ownedProject(deps, c.req.param("id"), userId, tenantId);
    if (!project) return c.json({ error: "not found" }, 404);
    const t = await getOrCreateProjectThread(deps.db, {
      id: project.id,
      userId,
      tenantId,
      threadId: project.threadId ?? null,
    });
    return c.json({ threadId: t.id });
  });

  // ─── Multi-session orchestrator endpoints (floating chat bubble) ──────────
  // The bubble lists / opens many orchestrator sessions per scope. `projectId`
  // query/body param selects project scope; omit it for workspace scope.

  app.get("/api/orchestrator-threads", async (c) => {
    const { userId, tenantId: _t } = c.get("claims");
    const projectId = c.req.query("projectId");
    if (projectId) {
      const project = await ownedProject(deps, projectId, userId, _t);
      if (!project) return c.json({ error: "not found" }, 404);
      return c.json(await listOrchestratorThreads(deps.db, { userId, projectId: project.id }));
    }
    return c.json(await listOrchestratorThreads(deps.db, { userId }));
  });

  app.post("/api/orchestrator-threads", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const raw = (await c.req.json().catch(() => ({}))) as { projectId?: unknown };
    const projectId = typeof raw.projectId === "string" ? raw.projectId : undefined;
    if (projectId) {
      const project = await ownedProject(deps, projectId, userId, tenantId);
      if (!project) return c.json({ error: "not found" }, 404);
      return c.json(await createOrchestratorThread(deps.db, { userId, tenantId, projectId: project.id }));
    }
    return c.json(await createOrchestratorThread(deps.db, { userId, tenantId }));
  });

  app.post("/api/projects", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const raw = await c.req.json().catch(() => null);
    const parsed = createProjectSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
    }
    if (!deps.projectDomain) {
      return c.json({ error: "project domain unavailable" }, 503);
    }
    // Verify default host belongs to caller before handing off to domain;
    // domain may not re-check and we don't want random hosts attached.
    if (!(await ownedHost(deps, parsed.data.defaultHostId, userId))) {
      return c.json({ error: "default host not found" }, 404);
    }
    try {
      // Note: `initGit` from the request body is intentionally dropped here —
      // the orchestrator calls `gitInitIfMissing` on first task dispatch
      // regardless, so an explicit flag at create-time is redundant. Kept in
      // the request schema so older clients can still send it; ignored.
      const project = await deps.projectDomain.createProject({
        tenantId,
        userId,
        name: parsed.data.name,
        description: parsed.data.description,
        repoPath: parsed.data.repoPath,
        defaultHostId: parsed.data.defaultHostId,
        mergePolicy: parsed.data.mergePolicy,
        testCommand: parsed.data.testCommand,
        concurrencyLimit: parsed.data.concurrencyLimit,
        systemPrompt: parsed.data.systemPrompt,
        pushToRemote: parsed.data.pushToRemote,
      });
      return c.json(project, 201);
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });

  app.get("/api/projects/:id", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const project = await ownedProject(deps, c.req.param("id"), userId, tenantId);
    if (!project) return c.json({ error: "not found" }, 404);
    const tasks = await listTasksByProject(deps.db, project.id);
    return c.json({ project, taskCount: tasks.length });
  });

  app.patch("/api/projects/:id", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const project = await ownedProject(deps, c.req.param("id"), userId, tenantId);
    if (!project) return c.json({ error: "not found" }, 404);
    const raw = await c.req.json().catch(() => null);
    const parsed = updateProjectSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
    }
    if (!deps.projectDomain) {
      return c.json({ error: "project domain unavailable" }, 503);
    }
    // If the user re-points to a new default host, ownership-check it too.
    if (
      parsed.data.defaultHostId &&
      parsed.data.defaultHostId !== project.defaultHostId &&
      !(await ownedHost(deps, parsed.data.defaultHostId, userId))
    ) {
      return c.json({ error: "default host not found" }, 404);
    }
    try {
      const updated = await deps.projectDomain.updateProject(project.id, parsed.data);
      return c.json(updated);
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });

  app.post("/api/projects/:id/archive", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const project = await ownedProject(deps, c.req.param("id"), userId, tenantId);
    if (!project) return c.json({ error: "not found" }, 404);
    if (!deps.projectDomain) {
      return c.json({ error: "project domain unavailable" }, 503);
    }
    try {
      await deps.projectDomain.archiveProject(project.id);
      return c.json({ ok: true });
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });

  // ─── Tasks (project-scoped list + create) ────────────────────────────────

  app.get("/api/projects/:id/tasks", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const project = await ownedProject(deps, c.req.param("id"), userId, tenantId);
    if (!project) return c.json({ error: "not found" }, 404);
    const tasks = await listTasksByProject(deps.db, project.id);
    return c.json(tasks);
  });

  app.post("/api/projects/:id/tasks", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const project = await ownedProject(deps, c.req.param("id"), userId, tenantId);
    if (!project) return c.json({ error: "not found" }, 404);
    const raw = await c.req.json().catch(() => null);
    const parsed = createTaskSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
    }
    if (!deps.projectDomain) {
      return c.json({ error: "project domain unavailable" }, 503);
    }
    if (parsed.data.hostId && !(await ownedHost(deps, parsed.data.hostId, userId))) {
      return c.json({ error: "host not found" }, 404);
    }
    try {
      const task = await deps.projectDomain.createTask({
        projectId: project.id,
        title: parsed.data.title,
        description: parsed.data.description,
        priority: parsed.data.priority,
        labels: parsed.data.labels,
        adapter: parsed.data.adapter,
        hostId: parsed.data.hostId,
      });
      return c.json(task, 201);
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });

  // ─── Tasks (task-scoped detail + actions) ────────────────────────────────

  app.get("/api/tasks/:taskId", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const taskId = c.req.param("taskId");
    // The runs query keys off taskId (the path param) and is independent of the
    // ownership check, so fire both in parallel instead of sequentially — one
    // fewer server→DB round trip on every task-card open. If ownership fails we
    // just discard the runs.
    const [owned, runs] = await Promise.all([
      ownedTask(deps, taskId, userId, tenantId),
      listTaskRuns(deps.db, taskId) as Promise<TaskRun[]>,
    ]);
    if (!owned) return c.json({ error: "not found" }, 404);
    return c.json({ task: owned.task, runs });
  });

  app.post("/api/tasks/:taskId/reply", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const owned = await ownedTask(deps, c.req.param("taskId"), userId, tenantId);
    if (!owned) return c.json({ error: "not found" }, 404);
    if (owned.task.state !== "needs-input") {
      return c.json({ error: "invalid-state", currentState: owned.task.state }, 409);
    }
    const raw = await c.req.json().catch(() => null);
    const parsed = replySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
    }
    if (!deps.projectDomain) {
      return c.json({ error: "project domain unavailable" }, 503);
    }
    try {
      // `replyToTask` reuses SP-1 ChatDomain.handleClientSend under the hood
      // — that's why userId + sourceClientId are required. sourceClientId from
      // an HTTP reply has no WS connection id; we pass the route literal so
      // event fan-out treats it as a side-channel reply (no echo suppression).
      await deps.projectDomain.replyToTask({
        taskId: owned.task.id,
        userId,
        content: parsed.data.content,
        sourceClientId: "rest:reply",
        ...(parsed.data.attachments && parsed.data.attachments.length > 0
          ? { attachments: parsed.data.attachments }
          : {}),
      });
      return c.json({ ok: true });
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });

  // Upload a file as context for a task reply. Mirrors the chat upload route
  // (POST /api/threads/:id/uploads) but resolves the host + scope key from the
  // task: uploads stage under the task's `executionThreadId`, and the host
  // materializes them into the task's worktree cwd at the next dispatch (which
  // is keyed by the same threadId). Returns the host's final (de-duped)
  // name+size; the UI names it in the next reply's `attachments`.
  app.post("/api/tasks/:taskId/uploads", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const owned = await ownedTask(deps, c.req.param("taskId"), userId, tenantId);
    if (!owned) return c.json({ error: "not found" }, 404);
    if (!owned.task.executionThreadId) return c.json({ error: "task not started" }, 409);

    const fileName = decodeURIComponent(c.req.header("X-Filename") ?? "").trim() || "upload";
    const declaredSize = Number(c.req.header("Content-Length") ?? 0) || 0;

    // Prefer the task's pinned host, else the project default. The file must
    // land on the host that owns the task's worktree.
    const hostId = owned.task.hostId ?? owned.project.defaultHostId;
    const online = deps.hosts.getOnlineHostsForUser(userId);
    if (!online.some((h) => h.hostId === hostId)) return c.json({ error: "no host online" }, 409);

    const body = c.req.raw.body;
    if (!body) return c.json({ error: "empty body" }, 400);

    try {
      const result = await relayUpload({
        hostId, threadId: owned.task.executionThreadId, fileName, declaredSize,
        body, sendRpc: sendHostRpc, chunkBytes: 2 * 1024 * 1024,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: "upload failed", detail: String(err) }, 502);
    }
  });

  app.post("/api/tasks/:taskId/accept", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const owned = await ownedTask(deps, c.req.param("taskId"), userId, tenantId);
    if (!owned) return c.json({ error: "not found" }, 404);
    if (owned.task.state !== "reviewing") {
      return c.json({ error: "invalid-state", currentState: owned.task.state }, 409);
    }
    if (!deps.projectDomain) {
      return c.json({ error: "project domain unavailable" }, 503);
    }
    try {
      await deps.projectDomain.acceptTask(owned.task.id);
      return c.json({ ok: true });
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });

  app.post("/api/tasks/:taskId/reject", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const owned = await ownedTask(deps, c.req.param("taskId"), userId, tenantId);
    if (!owned) return c.json({ error: "not found" }, 404);
    if (owned.task.state !== "reviewing") {
      return c.json({ error: "invalid-state", currentState: owned.task.state }, 409);
    }
    if (!deps.projectDomain) {
      return c.json({ error: "project domain unavailable" }, 503);
    }
    try {
      await deps.projectDomain.rejectTask(owned.task.id);
      return c.json({ ok: true });
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });

  app.post("/api/tasks/:taskId/retry", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const owned = await ownedTask(deps, c.req.param("taskId"), userId, tenantId);
    if (!owned) return c.json({ error: "not found" }, 404);
    if (owned.task.state !== "failed" && owned.task.state !== "done") {
      return c.json({ error: "invalid-state", currentState: owned.task.state }, 409);
    }
    if (!deps.projectDomain) {
      return c.json({ error: "project domain unavailable" }, 503);
    }
    try {
      await deps.projectDomain.retryTask(owned.task.id);
      return c.json({ ok: true });
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });

  app.post("/api/tasks/:taskId/cancel", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const owned = await ownedTask(deps, c.req.param("taskId"), userId, tenantId);
    if (!owned) return c.json({ error: "not found" }, 404);
    // Terminal states can't be cancelled.
    const terminal = new Set(["done", "failed", "cancelled"]);
    if (terminal.has(owned.task.state)) {
      return c.json({ error: "invalid-state", currentState: owned.task.state }, 409);
    }
    if (!deps.projectDomain) {
      return c.json({ error: "project domain unavailable" }, 503);
    }
    try {
      await deps.projectDomain.cancelTask(owned.task.id);
      return c.json({ ok: true });
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });

  // ─── Task comment feed (主页面) ───────────────────────────────────────────
  // The TaskDetail overview tab lists worker handoff notes + inert human
  // comments. Posting a comment never contacts the runner — it's folded into
  // the runner context only when the task is next (re)dispatched.

  app.get("/api/tasks/:taskId/comments", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const owned = await ownedTask(deps, c.req.param("taskId"), userId, tenantId);
    if (!owned) return c.json({ error: "not found" }, 404);
    if (!deps.projectDomain) return c.json({ error: "project domain unavailable" }, 503);
    return c.json(await deps.projectDomain.listComments(owned.task.id));
  });

  app.post("/api/tasks/:taskId/comments", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const owned = await ownedTask(deps, c.req.param("taskId"), userId, tenantId);
    if (!owned) return c.json({ error: "not found" }, 404);
    if (!deps.projectDomain) return c.json({ error: "project domain unavailable" }, 503);
    const parsed = commentBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
    }
    try {
      const comment = await deps.projectDomain.addUserComment({
        taskId: owned.task.id,
        userId,
        body: parsed.data.body,
        ...(parsed.data.parentCommentId ? { parentCommentId: parsed.data.parentCommentId } : {}),
        ...(parsed.data.attachments && parsed.data.attachments.length > 0
          ? { attachments: parsed.data.attachments }
          : {}),
      });
      return c.json(comment, 201);
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });

  app.delete("/api/tasks/:taskId/comments/:commentId", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const owned = await ownedTask(deps, c.req.param("taskId"), userId, tenantId);
    if (!owned) return c.json({ error: "not found" }, 404);
    if (!deps.projectDomain) return c.json({ error: "project domain unavailable" }, 503);
    try {
      await deps.projectDomain.deleteUserComment(c.req.param("commentId"));
      return c.json({ ok: true });
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });

  // ─── Kanban drag-to-column ────────────────────────────────────────────────
  // Dropping a task card onto a column issues this single mutation; the domain
  // maps the target column to the corresponding lifecycle action + side effects.

  app.patch("/api/tasks/:taskId/state", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const owned = await ownedTask(deps, c.req.param("taskId"), userId, tenantId);
    if (!owned) return c.json({ error: "not found" }, 404);
    if (!deps.projectDomain) return c.json({ error: "project domain unavailable" }, 503);
    const parsed = moveStateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
    }
    try {
      const task = await deps.projectDomain.moveTaskToState(owned.task.id, parsed.data.to);
      return c.json(task);
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });

  // ─── SP-4 hard-delete (task + project) ───────────────────────────────────
  // The workspace-chat orchestrator reaches these via the Host-token path;
  // the UI's per-card / per-project menu reaches them with a Bearer JWT.

  app.delete("/api/tasks/:taskId", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const owned = await ownedTask(deps, c.req.param("taskId"), userId, tenantId);
    if (!owned) return c.json({ error: "not found" }, 404);
    if (!deps.projectDomain) {
      return c.json({ error: "project domain unavailable" }, 503);
    }
    try {
      await deps.projectDomain.deleteTask(owned.task.id);
      return c.json({ ok: true });
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });

  app.delete("/api/projects/:id", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const project = await ownedProject(deps, c.req.param("id"), userId, tenantId);
    if (!project) return c.json({ error: "not found" }, 404);
    if (!deps.projectDomain) {
      return c.json({ error: "project domain unavailable" }, 503);
    }
    try {
      await deps.projectDomain.deleteProject(project.id);
      return c.json({ ok: true });
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });

  app.get("/api/tasks/:taskId/diff", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const owned = await ownedTask(deps, c.req.param("taskId"), userId, tenantId);
    if (!owned) return c.json({ error: "not found" }, 404);
    if (!deps.projectDomain) {
      return c.json({ error: "project domain unavailable" }, 503);
    }
    try {
      const diff = await deps.projectDomain.getTaskDiff(owned.task.id);
      return c.json(diff);
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });

  // ─── fs-browse on a host (NewProject step on web) ────────────────────────

  app.post("/api/hosts/:hostId/fs-browse", async (c) => {
    const { userId } = c.get("claims");
    const hostId = c.req.param("hostId");
    if (!(await ownedHost(deps, hostId, userId))) {
      return c.json({ error: "not found" }, 404);
    }
    const raw = await c.req.json().catch(() => ({}));
    const parsed = fsBrowseSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
    }
    if (!deps.projectDomain) {
      return c.json({ error: "project domain unavailable" }, 503);
    }
    try {
      const result = await deps.projectDomain.fsBrowse(hostId, parsed.data.path);
      return c.json(result);
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });

  // ─── SP-4 default-project-folder: set a host's projects-root ──────────────
  // Settings → Runner Hosts → "项目根目录" save button. The cloud forwards a
  // set-projects-root RPC to the host, persists the host's ~-expanded answer,
  // and pushes a host-meta update so every connected client refreshes the card.
  // 502 when the host is offline / the RPC fails; the env-locked host returns
  // its pinned root + locked:true (the write was a no-op).

  app.put("/api/hosts/:id/projects-root", async (c) => {
    const { userId } = c.get("claims");
    const id = c.req.param("id");
    const owned = await ownedHostRow(deps, id, userId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const raw = await c.req.json().catch(() => ({}));
    const parsed = z.object({ projectsRoot: z.string().min(1) }).safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid projectsRoot" }, 400);

    if (!deps.projectDomain) {
      return c.json({ error: "project domain unavailable" }, 503);
    }

    let result: { projectsRoot: string; locked: boolean };
    try {
      result = await deps.projectDomain.setProjectsRoot(id, parsed.data.projectsRoot);
    } catch (err) {
      logger.warn({ hostId: id, err: String(err) }, "set projects-root RPC failed");
      return c.json({ error: "host unavailable" }, 502);
    }

    const { setHostProjectsRoot } = await import("../db/hosts.js");
    await setHostProjectsRoot(deps.db, id, result.projectsRoot, result.locked);
    deps.clients.publishHostMeta(userId, {
      hostId: id,
      name: owned.name,
      status: owned.status as "online" | "offline",
      lastSeen: owned.lastSeen ? owned.lastSeen.toISOString() : null,
    });
    return c.json(result);
  });

  // PUT /api/hosts/:id/keep-awake — sends set-keep-awake RPC to the host,
  // persists the effective state, and pushes a host-meta update. 502 when the
  // host is offline / the RPC fails; an env-locked host returns its pinned
  // state + locked:true (the write was a no-op).
  app.put("/api/hosts/:id/keep-awake", async (c) => {
    const { userId } = c.get("claims");
    const id = c.req.param("id");
    const owned = await ownedHostRow(deps, id, userId);
    if (!owned) return c.json({ error: "not found" }, 404);

    const raw = await c.req.json().catch(() => ({}));
    const parsed = z.object({ enabled: z.boolean() }).safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid enabled" }, 400);

    if (!deps.projectDomain) {
      return c.json({ error: "project domain unavailable" }, 503);
    }

    let result: { enabled: boolean; locked: boolean };
    try {
      result = await deps.projectDomain.setKeepAwake(id, parsed.data.enabled);
    } catch (err) {
      logger.warn({ hostId: id, err: String(err) }, "set keep-awake RPC failed");
      return c.json({ error: "host unavailable" }, 502);
    }

    const { setHostKeepAwake } = await import("../db/hosts.js");
    await setHostKeepAwake(deps.db, id, result.enabled, result.locked);
    deps.clients.publishHostMeta(userId, {
      hostId: id,
      name: owned.name,
      status: owned.status as "online" | "offline",
      lastSeen: owned.lastSeen ? owned.lastSeen.toISOString() : null,
    });
    return c.json(result);
  });

  // ─── SP-4 Artifacts: project file browser (tree + file bytes) ─────────────
  // Confined to the project's repoPath so a crafted ?path can't read arbitrary
  // host disk. Both endpoints resolve the requested path and verify it stays
  // under repoPath before forwarding to the host.

  app.get("/api/projects/:id/browse", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const project = await ownedProject(deps, c.req.param("id"), userId, tenantId);
    if (!project) return c.json({ error: "not found" }, 404);
    if (!deps.projectDomain) return c.json({ error: "project domain unavailable" }, 503);
    // Default to the repo root; any provided path must stay under it.
    const reqPath = c.req.query("path") || project.repoPath;
    if (!pathUnder(project.repoPath, reqPath)) {
      return c.json({ error: "path outside project" }, 403);
    }
    try {
      const result = await deps.projectDomain.fsBrowse(project.defaultHostId, reqPath);
      return c.json(result);
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });

  app.get("/api/projects/:id/file", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const project = await ownedProject(deps, c.req.param("id"), userId, tenantId);
    if (!project) return c.json({ error: "not found" }, 404);
    if (!deps.projectDomain) return c.json({ error: "project domain unavailable" }, 503);
    const reqPath = c.req.query("path");
    if (!reqPath) return c.json({ error: "path required" }, 400);
    if (!pathUnder(project.repoPath, reqPath)) {
      return c.json({ error: "path outside project" }, 403);
    }
    try {
      const file = await deps.projectDomain.readFile(project.defaultHostId, reqPath);
      return artifactFileResponse(c, reqPath, file);
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
    }
  });
}
