import type { Hono } from "hono";
import { z } from "zod";
import { logger } from "@cogni/shared";
import {
  mergePolicySchema,
  prioritySchema,
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
import { hosts as hostsTable } from "../db/schema.js";
import { eq, and, isNull } from "drizzle-orm";
import { artifactFileResponse, pathUnder } from "./artifact-file.js";
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
});

const replySchema = z.object({
  content: z.string().min(1).max(20_000),
});

const fsBrowseSchema = z.object({
  path: z.string().optional(),
});

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
    try {
      const task = await deps.projectDomain.createTask({
        projectId: project.id,
        title: parsed.data.title,
        description: parsed.data.description,
        priority: parsed.data.priority,
        labels: parsed.data.labels,
        adapter: parsed.data.adapter,
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
    const owned = await ownedTask(deps, c.req.param("taskId"), userId, tenantId);
    if (!owned) return c.json({ error: "not found" }, 404);
    const runs: TaskRun[] = await listTaskRuns(deps.db, owned.task.id);
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
      });
      return c.json({ ok: true });
    } catch (err) {
      const { status, body } = domainErrorResponse(err);
      return c.json(body, status);
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
