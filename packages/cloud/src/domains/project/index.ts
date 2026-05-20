/**
 * SP-3 ProjectDomain — the use-case-level surface for HTTP routes (Track C).
 *
 * Three categories of methods:
 *   1. CRUD for projects / tasks (create, list, get, archive, update)
 *   2. Task action API (reply / accept / reject / retry / cancel / getDiff)
 *   3. Auxiliary host RPC passthrough (fsBrowse — exposed for the web
 *      NewProject flow which doesn't have its own backend route abstraction)
 *
 * Pattern mirrors SP-1 ChatDomain: hold a small set of injected deps, expose
 * verbs the route layer calls. Lifecycle changes route through
 * `lifecycle.transitionTask` so the state machine is the single source of
 * truth. Side effects on the host (worktree create/remove, merge, runner
 * dispatch) route through HostRpcClient + HostRouter respectively.
 *
 * Wiring with the orchestrator: orchestrator runs its own 5s tick and uses
 * the same deps; ProjectDomain.dispose() stops it. The two collaborate via
 * the DB + ClientHub, not direct method calls — keeps each independent
 * enough to test in isolation.
 *
 * Note on `replyToTask`: the simplest correct implementation reuses SP-1
 * ChatDomain.handleClientSend against the task's executionThreadId. We
 * inject ChatDomain to keep that path single. Caller (Track C route) is
 * expected to pass userId from JWT claims.
 */

import {
  createProject as dbCreateProject,
  listProjects as dbListProjects,
  getProject as dbGetProject,
  archiveProject as dbArchiveProject,
  updateProject as dbUpdateProject,
  createTask as dbCreateTask,
  listTasksByProject as dbListTasksByProject,
  getTask as dbGetTask,
  getTaskByThreadId as dbGetTaskByThreadId,
  listTaskRuns as dbListTaskRuns,
  deleteTask as dbDeleteTask,
  deleteProject as dbDeleteProject,
  type CreateProjectInput,
  type CreateTaskInput,
  type UpdateProjectPatch,
} from "../../db/projects.js";
import { createThread, appendMessage, touchThread } from "../../db/threads.js";
import { closeRunnerSession, getLatestSessionForThread } from "../../db/sessions.js";
import type { AnyDb } from "../../db/users.js";
import type { ClientHub } from "../../client-hub.js";
import type { HostRouter } from "../../host-router.js";
import type {
  Project,
  ProjectTask,
  TaskRun,
  TaskState,
  FsBrowseResponse,
  ReadFileResponse,
  GitDiffSnapshotResponse,
} from "@cogni/contract";
import type { ChatDomain } from "../chat.js";
import { HostRpcClient, HostRpcError, type HostRpcLogger } from "./host-rpc.js";
import { transitionTask, StateMismatch } from "./lifecycle.js";
import { evaluateAndApplyMergeGate } from "./merge-gate.js";
import { ProjectOrchestrator } from "./orchestrator.js";

export interface ProjectDomainDeps {
  db: AnyDb;
  hostRpc: HostRpcClient;
  hostRouter: HostRouter;
  clients: ClientHub;
  chat: ChatDomain;
  logger?: HostRpcLogger;
}

export class ProjectDomain {
  private readonly orchestrator: ProjectOrchestrator;

  constructor(private readonly deps: ProjectDomainDeps) {
    this.orchestrator = new ProjectOrchestrator({
      db: deps.db,
      hostRpc: deps.hostRpc,
      hostRouter: deps.hostRouter,
      clients: deps.clients,
      logger: deps.logger,
    });
  }

  /** Start the background reconcile loop. Idempotent. */
  start(): void {
    this.orchestrator.start();
  }

  /** Stop the loop. Use in tests + graceful shutdown. */
  dispose(): void {
    this.orchestrator.stop();
  }

  // ─── Projects ─────────────────────────────────────────────────────────────

  async createProject(input: CreateProjectInput): Promise<Project> {
    const project = await dbCreateProject(this.deps.db, input);
    this.deps.clients.broadcastProjects(project.userId, {
      t: "project-event",
      kind: "created",
      project,
    });
    return project;
  }

  async listProjects(tenantId: string, userId: string, includeArchived = false): Promise<Project[]> {
    return dbListProjects(this.deps.db, { tenantId, userId, includeArchived });
  }

  async getProject(projectId: string): Promise<Project | null> {
    return dbGetProject(this.deps.db, projectId);
  }

  async updateProject(projectId: string, patch: UpdateProjectPatch): Promise<Project> {
    const project = await dbUpdateProject(this.deps.db, projectId, patch);
    this.deps.clients.broadcastProjects(project.userId, {
      t: "project-event",
      kind: "updated",
      project,
    });
    this.deps.clients.broadcastProject(project.id, {
      t: "project-event",
      kind: "updated",
      project,
    });
    return project;
  }

  async archiveProject(projectId: string): Promise<Project> {
    const before = await dbGetProject(this.deps.db, projectId);
    if (!before) throw new Error(`project ${projectId} not found`);
    await dbArchiveProject(this.deps.db, projectId);
    const after = await dbGetProject(this.deps.db, projectId);
    if (!after) throw new Error(`project ${projectId} not found after archive`);
    this.deps.clients.broadcastProjects(after.userId, {
      t: "project-event",
      kind: "archived",
      project: after,
    });
    return after;
  }

  // ─── Tasks ────────────────────────────────────────────────────────────────

  async createTask(input: CreateTaskInput): Promise<ProjectTask> {
    // Every task owns one thread — the orchestrator's runner_session streams
    // events into it, and the drawer's <ChatBlocks> subscribes to it. Created
    // up-front (not lazily at dispatch time) so:
    //   1. the drawer can render an empty timeline immediately on click, and
    //   2. the orchestrator's dispatch loop can rely on `executionThreadId`
    //      being non-null (it skips tasks that lack one).
    // Thread title = task title so the chat sidebar / Recents lists show
    // something meaningful if the user clicks through from there.
    const project = await dbGetProject(this.deps.db, input.projectId);
    if (!project) throw new Error(`project ${input.projectId} not found`);
    const thread = await createThread(this.deps.db, {
      userId: project.userId,
      tenantId: project.tenantId,
      title: input.title,
    });
    const task = await dbCreateTask(this.deps.db, {
      ...input,
      executionThreadId: thread.id,
    });
    this.deps.clients.broadcastProject(task.projectId, {
      t: "task-event",
      kind: "created",
      task,
    });
    return task;
  }

  async listTasks(projectId: string): Promise<ProjectTask[]> {
    return dbListTasksByProject(this.deps.db, projectId);
  }

  async getTask(taskId: string): Promise<ProjectTask | null> {
    return dbGetTask(this.deps.db, taskId);
  }

  /** Drawer "history" tab loads {task, runs} in one round trip. */
  async getTaskDetail(taskId: string): Promise<{ task: ProjectTask; runs: TaskRun[] } | null> {
    const task = await dbGetTask(this.deps.db, taskId);
    if (!task) return null;
    const runs = await dbListTaskRuns(this.deps.db, taskId);
    return { task, runs };
  }

  /**
   * User replies to a `needs-input` task. Spec §四 "needs-input 重新赋义":
   *   1. Append a user message to the task's executionThreadId
   *   2. transitionTask needs-input → running (clears needsInputWhat)
   *   3. Re-dispatch a runner turn via SP-1 ChatDomain.handleClientSend
   *      (that path already handles host selection + runner_session reuse)
   *
   * `sourceClientId` is needed by handleClientSend for response-only frames;
   * routes pass the WS client that originated the request (or a synthetic
   * id for HTTP routes — no response will land back on it, which is fine).
   */
  async replyToTask(input: {
    taskId: string;
    userId: string;
    content: string;
    sourceClientId: string;
  }): Promise<ProjectTask> {
    const task = await dbGetTask(this.deps.db, input.taskId);
    if (!task) throw new Error(`task ${input.taskId} not found`);
    if (task.state !== "needs-input") {
      throw new Error(`replyToTask: task ${input.taskId} is in state ${task.state}, not needs-input`);
    }
    if (!task.executionThreadId) {
      throw new Error(`replyToTask: task ${input.taskId} has no executionThreadId`);
    }

    const updated = await transitionTask(this.deps.db, input.taskId, "needs-input", "running", {
      needsInputWhat: null,
    });
    this.broadcastTask(updated, "state-changed");

    // Reuse SP-1's send pipeline: writes message to thread, opens/reuses
    // runner_session, sends dispatch frame to the host. This is the same
    // code path the chat UI uses; the runner's --resume keeps context.
    await this.deps.chat.handleClientSend({
      userId: input.userId,
      threadId: task.executionThreadId,
      content: input.content,
      sourceClientId: input.sourceClientId,
    });

    return updated;
  }

  /**
   * Accept a reviewing task. Drives the auto-merge sub-flow regardless of
   * project policy (the user has clicked Accept, so consent is explicit).
   * On merge failure, task stays in `reviewing` and we surface the host's
   * error message to the caller.
   */
  async acceptTask(taskId: string): Promise<ProjectTask> {
    const task = await dbGetTask(this.deps.db, taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    if (task.state !== "reviewing") {
      throw new Error(`acceptTask: task is in ${task.state}, not reviewing`);
    }
    const project = await dbGetProject(this.deps.db, task.projectId);
    if (!project) throw new Error(`project ${task.projectId} not found`);

    // Run the merge-gate with an overlay forcing auto-merge semantics for
    // this one call. We don't mutate the project — just pass an overlay obj.
    const overlay: Project = { ...project, mergePolicy: "auto-merge" };
    const next = await evaluateAndApplyMergeGate(
      { hostRpc: this.deps.hostRpc, logger: this.deps.logger },
      overlay,
      task,
    );
    if (next !== "done") {
      // Merge failed (conflict / RPC error) — keep task in reviewing; caller
      // sees the unchanged state and the host error in logs.
      throw new HostRpcError(
        "git-merge-to-main",
        "merge-failed",
        "acceptTask: merge-to-main did not complete; task remains in reviewing",
      );
    }
    const updated = await transitionTask(this.deps.db, taskId, "reviewing", "done", {
      // Worktree was removed by merge-gate; null the FK fields so the
      // UI doesn't show stale paths.
      worktreePath: null,
    });
    this.broadcastTask(updated, "state-changed");
    return updated;
  }

  /**
   * Reject a reviewing task. Removes the worktree + branch (force=true so
   * an unmerged branch can be discarded), then marks failed. The
   * orchestrator won't auto-retry because retries < maxRetries logic is
   * only invoked by user-initiated retryTask in MVP.
   */
  async rejectTask(taskId: string): Promise<ProjectTask> {
    const task = await dbGetTask(this.deps.db, taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    if (task.state !== "reviewing") {
      throw new Error(`rejectTask: task is in ${task.state}, not reviewing`);
    }
    if (task.hostId && task.worktreePath) {
      const project = await dbGetProject(this.deps.db, task.projectId);
      try {
        await this.deps.hostRpc.gitWorktreeRemove(task.hostId, {
          worktreePath: task.worktreePath,
          force: true,
          // Discard the unmerged task branch too (git -D).
          ...(project && task.branchName
            ? { repoPath: project.repoPath, branchName: task.branchName }
            : {}),
        });
      } catch (err) {
        this.deps.logger?.warn?.(
          { taskId, err: String(err) },
          "rejectTask: worktree-remove failed; proceeding to mark task failed anyway",
        );
      }
    }
    const updated = await transitionTask(this.deps.db, taskId, "reviewing", "failed", {
      worktreePath: null,
    });
    this.broadcastTask(updated, "state-changed");
    return updated;
  }

  /**
   * Retry a failed/done/cancelled task. Resets state to queued; orchestrator
   * will dispatch on next tick. Worktree stays (sticky branch — runner picks
   * up where it left off).
   */
  async retryTask(taskId: string): Promise<ProjectTask> {
    const task = await dbGetTask(this.deps.db, taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    if (task.state !== "failed" && task.state !== "done" && task.state !== "cancelled") {
      throw new Error(`retryTask: task is in ${task.state}, not a terminal state`);
    }
    const updated = await transitionTask(this.deps.db, taskId, task.state, "queued", {
      // Clear lifecycle markers from the previous attempt; orchestrator
      // will set them again on next dispatch.
      startedAt: null,
      completedAt: null,
      retries: task.retries + 1,
    });
    this.broadcastTask(updated, "state-changed");
    return updated;
  }

  /**
   * Cancel a non-terminal task. Closes the runner_session if any (SP-1
   * helper) and removes the worktree if we have one. If the task is
   * already terminal we throw — UI should hide the cancel button on those.
   */
  async cancelTask(taskId: string): Promise<ProjectTask> {
    const task = await dbGetTask(this.deps.db, taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    if (task.state === "done" || task.state === "failed" || task.state === "cancelled") {
      throw new Error(`cancelTask: task already terminal (${task.state})`);
    }
    // Close the active runner_session if any. SP-1's host doesn't have a
    // "kill running session" command in MVP — the runner will see its WS
    // session marked closed and (in the next pass) the host removes the
    // worktree under it. Documented gap: SP-3+1 adds a "stop runner" host RPC.
    if (task.executionThreadId) {
      const latest = await getLatestSessionForThread(this.deps.db, task.executionThreadId);
      if (latest && latest.status !== "closed") {
        await closeRunnerSession(this.deps.db, latest.id);
      }
    }
    if (task.hostId && task.worktreePath) {
      const project = await dbGetProject(this.deps.db, task.projectId);
      try {
        await this.deps.hostRpc.gitWorktreeRemove(task.hostId, {
          worktreePath: task.worktreePath,
          force: true,
          // Discard the unmerged task branch too (git -D). repoPath only
          // present if we could resolve the project (always, in practice).
          ...(project && task.branchName
            ? { repoPath: project.repoPath, branchName: task.branchName }
            : {}),
        });
      } catch (err) {
        this.deps.logger?.warn?.(
          { taskId, err: String(err) },
          "cancelTask: worktree-remove failed; proceeding to mark task cancelled anyway",
        );
      }
    }
    const updated = await transitionTask(this.deps.db, taskId, task.state, "cancelled", {
      worktreePath: null,
    });
    this.broadcastTask(updated, "state-changed");
    return updated;
  }

  /**
   * SP-4 hard-delete a task. Idempotent (no-op if already gone). If the task
   * is non-terminal we cancel it first (closes runner session + removes
   * worktree via `cancelTask`), then delete the row and broadcast a
   * task-event(deleted) so the kanban card disappears for every viewer.
   */
  async deleteTask(taskId: string): Promise<void> {
    const task = await dbGetTask(this.deps.db, taskId);
    if (!task) return; // idempotent
    const terminal =
      task.state === "done" || task.state === "failed" || task.state === "cancelled";
    if (!terminal) {
      try {
        await this.cancelTask(taskId);
      } catch (err) {
        this.deps.logger?.warn?.(
          { taskId, err: String(err) },
          "deleteTask: cancel before delete failed; deleting anyway",
        );
      }
    }
    await dbDeleteTask(this.deps.db, taskId);
    this.deps.clients.broadcastProject(task.projectId, { t: "task-event", kind: "deleted", task });
    this.deps.clients.broadcastTask(task.id, { t: "task-event", kind: "deleted", task });
  }

  /**
   * SP-4 hard-delete a project + all its tasks (no undo window). Deletes each
   * task through `deleteTask` (so running runners are cancelled first), then
   * removes the project row and broadcasts project-event(deleted) — the
   * project vanishes from the list page and its board for every viewer.
   */
  async deleteProject(projectId: string): Promise<void> {
    const project = await dbGetProject(this.deps.db, projectId);
    if (!project) return; // idempotent
    const tasks = await dbListTasksByProject(this.deps.db, projectId);
    for (const t of tasks) await this.deleteTask(t.id);
    await dbDeleteProject(this.deps.db, projectId);
    this.deps.clients.broadcastProjects(project.userId, {
      t: "project-event",
      kind: "deleted",
      project,
    });
    this.deps.clients.broadcastProject(project.id, {
      t: "project-event",
      kind: "deleted",
      project,
    });
  }

  /** Drawer "Review" tab fetches diff on-demand via host RPC. */
  async getTaskDiff(taskId: string): Promise<GitDiffSnapshotResponse> {
    const task = await dbGetTask(this.deps.db, taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    if (!task.hostId || !task.worktreePath) {
      throw new Error(`getTaskDiff: task ${taskId} has no worktree (state=${task.state})`);
    }
    return this.deps.hostRpc.gitDiffSnapshot(task.hostId, {
      worktreePath: task.worktreePath,
    });
  }

  /**
   * Web NewProject "📁 Browse" — passthrough to the host's fs-browse RPC.
   * Authorization is the route's responsibility (verify that hostId belongs
   * to the JWT user); this method itself is not user-scoped.
   */
  async fsBrowse(hostId: string, path?: string): Promise<FsBrowseResponse> {
    return this.deps.hostRpc.fsBrowse(hostId, { path });
  }

  /**
   * SP-4 Artifacts: read a host file's bytes (base64). Authorization +
   * path-confinement are the route's responsibility (project repo root /
   * thread scratch dir); this is a thin passthrough to the host RPC.
   */
  async readFile(hostId: string, path: string, maxBytes?: number): Promise<ReadFileResponse> {
    return this.deps.hostRpc.readFile(hostId, maxBytes != null ? { path, maxBytes } : { path });
  }

  /**
   * Hook from SP-1 chat path: when a runner emits `done` on a task's
   * executionThreadId, the chat domain finalizes the message; this method
   * then runs the merge-gate to decide reviewing vs done vs reviewing-on-fail.
   * Track C's POST /actions or a higher-level "runner-done" listener wires
   * this up; for SP-3 MVP the orchestrator's reconcile picks up
   * reviewing-state tasks on the next tick too (defense in depth).
   */
  /**
   * SP-3 needs-input bridge — invoked by ChatDomain when it sees a runner
   * `AskUserQuestion` tool-call on a thread that belongs to a project task.
   *
   * **Surface:** the project board's T-x card moves from "进行中" to "等待
   * 输入" (purple pulse). Clicking the card opens the drawer with the
   * runner's question rendered in the state stepper area, and the reply
   * box accepts a free-form text answer. On reply submit, ProjectDomain's
   * `replyToTask` path transitions the task back to `running` and forwards
   * the answer to the runner via SP-1's ChatDomain.handleClientSend.
   *
   * **Idempotent / safe:** no-op when the thread isn't a task (chat-only),
   * when the task isn't in `running` (already paused, already done,
   * cancelled), or when the questionText is empty.
   */
  async handleAskUserQuestion(threadId: string, questionText: string): Promise<void> {
    const task = await dbGetTaskByThreadId(this.deps.db, threadId);
    if (!task) return; // chat thread, not a task — no lifecycle to pause
    if (task.state !== "running") return; // already paused / terminal — ignore
    const trimmed = questionText.trim();
    if (!trimmed) return;
    try {
      const updated = await transitionTask(this.deps.db, task.id, "running", "needs-input", {
        needsInputWhat: trimmed,
      });
      this.broadcastTask(updated, "state-changed");
    } catch (err) {
      if (err instanceof StateMismatch) return; // raced — orchestrator/another path moved it
      this.deps.logger?.warn?.(
        { taskId: task.id, err: String(err) },
        "handleAskUserQuestion: transition running→needs-input threw",
      );
    }
  }

  async handleRunnerDoneForTask(taskId: string): Promise<void> {
    const task = await dbGetTask(this.deps.db, taskId);
    if (!task || task.state !== "running") return;
    const project = await dbGetProject(this.deps.db, task.projectId);
    if (!project) return;
    let next: TaskState;
    try {
      next = await evaluateAndApplyMergeGate(
        { hostRpc: this.deps.hostRpc, logger: this.deps.logger },
        project,
        task,
      );
    } catch (err) {
      this.deps.logger?.warn?.({ taskId, err: String(err) }, "handleRunnerDone: merge-gate threw");
      next = "reviewing";
    }
    try {
      const updated = await transitionTask(this.deps.db, taskId, "running", next, {
        worktreePath: next === "done" ? null : task.worktreePath,
      });
      this.broadcastTask(updated, "state-changed");
    } catch (err) {
      if (err instanceof StateMismatch) return; // raced; ignore
      throw err;
    }
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private broadcastTask(task: ProjectTask, kind: "created" | "updated" | "deleted" | "state-changed"): void {
    this.deps.clients.broadcastTask(task.id, { t: "task-event", kind, task });
    this.deps.clients.broadcastProject(task.projectId, { t: "task-event", kind, task });
  }
}

// Re-export the key sub-types so route layer / tests can import from one place.
export { transitionTask, StateMismatch, IllegalTransition, LEGAL_TRANSITIONS } from "./lifecycle.js";
export { HostRpcClient, HostRpcError } from "./host-rpc.js";
export { evaluateAndApplyMergeGate } from "./merge-gate.js";
export { ProjectOrchestrator } from "./orchestrator.js";

// Avoid unused-import warning for utility functions reserved for future paths
// (cancel currently uses closeRunnerSession; appendMessage/touchThread will
// be used when SP-3+1 adds the in-domain message persistence — kept here so
// adding them later is a one-line change).
void appendMessage;
void touchThread;
