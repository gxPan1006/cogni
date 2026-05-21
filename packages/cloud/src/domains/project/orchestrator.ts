/**
 * SP-3 project orchestrator — the reconcile loop.
 *
 * Single-node MVP: a 5s `setInterval` tick on every cloud node (currently
 * only one). Each tick:
 *
 *   Phase 1 — reconcile: scan tasks in non-terminal "active" states
 *     (`running`, `needs-input`, `reviewing`) and patch up state when
 *     external conditions (host went offline, runner died, mergePolicy
 *     deferred) drifted it from what's persisted:
 *       - `running` + host offline > 60s → log warning. We *don't* mark
 *         failed here because SP-2 session-resume re-attaches the runner on
 *         host reconnect (spec §五.reconcile + §十一 链路 C).
 *       - `reviewing` + project.mergePolicy ≠ require-review → re-run the
 *         merge gate (covers the case where the task entered `reviewing`
 *         under one policy but the user has since edited the project to
 *         auto-merge).
 *
 *   Phase 2 — dispatch: for each active project, pick queued tasks in
 *     priority order while the project's running count < concurrencyLimit.
 *     For each picked task:
 *       1. `git-init-if-missing` on the project's defaultHost (idempotent)
 *       2. `git-worktree-create` for a fresh per-task branch
 *       3. open a SP-1 runner_session row pinned to (task, host)
 *       4. send a `dispatch` frame to the host so the runner starts at
 *          cwd=worktreePath
 *       5. transitionTask queued→running with hostId/worktreePath/branchName
 *       6. createTaskRun (attempt=prev+1)
 *       7. broadcast task-event + project-event
 *
 *     If any host RPC fails (host offline, RPC error), we skip this task for
 *     this tick — the next tick retries. We do NOT mark the task `failed` for
 *     a transient host hiccup; that's reserved for runner-level errors which
 *     flow via SP-1's event path (handled by SP-1 chat domain → events table).
 *
 *   Phase 3 — retry: spec §五.retry mentions this as a separate phase. We
 *     fold it into dispatch: if a task is in `failed` state with retries <
 *     maxRetries, we don't auto-restart on the orchestrator's own
 *     initiative — that's an explicit user action (replyToTask /
 *     retryTask) in MVP. SP-3+1 adds automatic exponential-backoff retry.
 *
 * What this does NOT do:
 *   - listen to runner events (SP-1 ChatDomain.handleHostEvent already
 *     ingests them into events/messages tables; the merge-gate hook in
 *     reconcile picks up the resulting completed runner_session row when
 *     the task drifts to `reviewing` via ChatDomain's `done` handler — see
 *     ProjectDomain.handleRunnerDone wiring)
 *   - drive the lifecycle on user requests (use-cases live in ProjectDomain;
 *     orchestrator is purely background)
 */

import { eq, inArray, isNull } from "drizzle-orm";
import { projectTasks, projects as projectsTable, hosts as hostsTable } from "../../db/schema.js";
import type { AnyDb } from "../../db/users.js";
import {
  getProject,
  createTaskRun,
  listTaskRuns,
} from "../../db/projects.js";
import { openRunnerSession, getLatestSessionForThread } from "../../db/sessions.js";
import type { ClientHub } from "../../client-hub.js";
import type { HostRouter } from "../../host-router.js";
import type { Project, ProjectTask, TaskState, TaskComment, CloudToHost } from "@cogni/contract";
import { HostRpcError, type HostRpcClient, type HostRpcLogger } from "./host-rpc.js";
import type { PushNotifier } from "../../push/notifier.js";
import { evaluateAndApplyMergeGate } from "./merge-gate.js";
import { transitionTask, StateMismatch } from "./lifecycle.js";
import { gatherUnconsumedUserComments, markCommentsConsumed } from "../../db/task-comments.js";
import { renderCommentsForRunner, commentAttachments, captureWorkerNote } from "./comments.js";

const TICK_INTERVAL_MS = 5_000;
const HOST_OFFLINE_THRESHOLD_MS = 60_000;
// SP-3 has no per-project default adapter column yet; orchestrator falls back
// to "claude-code" until SP-3+1 adds `projects.default_adapter`. Document this
// at the dispatch call-site too.
const DEFAULT_ADAPTER = "claude-code";

export interface OrchestratorDeps {
  db: AnyDb;
  hostRpc: HostRpcClient;
  hostRouter: HostRouter;
  clients: ClientHub;
  logger?: HostRpcLogger;
  /** Optional: Web Push on task state changes. Undefined ⇒ push disabled. */
  pushNotifier?: PushNotifier;
}

const ACTIVE_STATES: TaskState[] = ["running", "needs-input", "reviewing"];

export class ProjectOrchestrator {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy guard: a slow tick must not stack with the next interval fire. */
  private ticking = false;

  constructor(private readonly deps: OrchestratorDeps) {}

  start(): void {
    if (this.timer) return; // idempotent
    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One reconcile + dispatch pass. Tests drive this directly to avoid
   * waiting on the 5s interval. Re-entry is no-op; failures are caught and
   * logged so a single bad project can't kill the loop.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.reconcileActiveTasks();
      await this.dispatchQueuedTasks();
    } catch (err) {
      this.deps.logger?.warn?.({ err: String(err) }, "orchestrator tick failed");
    } finally {
      this.ticking = false;
    }
  }

  // ─── Phase 1: reconcile ───────────────────────────────────────────────────

  private async reconcileActiveTasks(): Promise<void> {
    const rows = await this.deps.db
      .select()
      .from(projectTasks)
      .where(inArray(projectTasks.state, ACTIVE_STATES));

    for (const row of rows) {
      const task = await this.fetchTaskById(row.id);
      if (!task) continue;

      if (task.state === "running" && task.hostId) {
        // SP-3: a `running` task whose latest runner_session is already
        // `completed` / `failed` means the runner finished but no one drove
        // the lifecycle past `running`. (SP-1's ChatDomain.handleSessionUpdate
        // updates runner_sessions.status but doesn't know about tasks; we
        // close the loop here so the user doesn't see a stuck-running card.)
        const finalized = await this.maybeFinalizeRunningTask(task);
        if (finalized) continue;
        await this.warnIfHostOffline(task);
      } else if (task.state === "reviewing") {
        await this.maybeReapplyMergeGate(task);
      }
    }
  }

  /**
   * If the latest runner_session for `task.executionThreadId` is `completed`
   * or `failed`, drive the task lifecycle to the next state. Returns true if
   * a transition fired (caller should skip the host-offline warn for this
   * task). The merge-gate decides reviewing vs done vs reviewing-on-fail
   * via `handleRunnerDoneForTask`; we just gate it on session status.
   */
  private async maybeFinalizeRunningTask(task: ProjectTask): Promise<boolean> {
    if (!task.executionThreadId) return false;
    const session = await getLatestSessionForThread(
      this.deps.db,
      task.executionThreadId,
    );
    if (!session) return false;
    if (session.status === "completed") {
      // Inline mirror of ProjectDomain.handleRunnerDoneForTask to avoid the
      // orchestrator→domain back-reference: evaluate the merge gate against
      // the project's current mergePolicy, then transition running → next.
      // For require-review (default) the gate returns 'reviewing' and the
      // worktree stays put for the user to inspect; for auto-merge variants
      // it returns 'done' and the gate has already run git-merge-to-main +
      // worktree-remove host RPCs so worktreePath is cleared on transition.
      const project = await getProject(this.deps.db, task.projectId);
      if (!project) return false;
      let next: TaskState;
      try {
        next = await evaluateAndApplyMergeGate(
          { hostRpc: this.deps.hostRpc, logger: this.deps.logger },
          project,
          task,
        );
      } catch (err) {
        this.deps.logger?.warn?.(
          { taskId: task.id, err: String(err) },
          "orchestrator: merge-gate threw on running-done",
        );
        next = "reviewing";
      }
      try {
        const updated = await transitionTask(this.deps.db, task.id, "running", next, {
          worktreePath: next === "done" ? null : task.worktreePath,
        });
        this.broadcastTask(updated, "state-changed");
        this.broadcastProject(project, "updated");
        // Snapshot the runner's final assistant message into the feed as a
        // "worker" handoff card (→ 完成 / → 待 Review). This MUST live here:
        // the orchestrator tick is the live finalize path (ProjectDomain.
        // handleRunnerDoneForTask is not wired), so without this no worker card
        // is ever created on completion. Best-effort — never blocks the
        // transition (captureWorkerNote swallows its own errors).
        const note = await captureWorkerNote(
          this.deps.db,
          { taskId: task.id, state: next, threadId: task.executionThreadId },
          this.deps.logger,
        );
        if (note) {
          this.deps.clients.broadcastTask(note.taskId, { t: "task-comment", kind: "created", comment: note });
        }
      } catch (err) {
        if (!(err instanceof StateMismatch)) {
          this.deps.logger?.warn?.(
            { taskId: task.id, err: String(err) },
            "orchestrator: transition running→next threw",
          );
        }
      }
      return true;
    }
    if (session.status === "failed") {
      try {
        const updated = await transitionTask(this.deps.db, task.id, "running", "failed");
        this.broadcastTask(updated, "state-changed");
      } catch (err) {
        if (!(err instanceof StateMismatch)) {
          this.deps.logger?.warn?.(
            { taskId: task.id, err: String(err) },
            "orchestrator: failed-transition threw",
          );
        }
      }
      return true;
    }
    return false;
  }

  private async warnIfHostOffline(task: ProjectTask): Promise<void> {
    if (!task.hostId) return;
    const rows = await this.deps.db
      .select({ lastSeen: hostsTable.lastSeen })
      .from(hostsTable)
      .where(eq(hostsTable.id, task.hostId))
      .limit(1);
    const lastSeen = rows[0]?.lastSeen;
    if (!lastSeen) return;
    const ageMs = Date.now() - lastSeen.getTime();
    if (ageMs > HOST_OFFLINE_THRESHOLD_MS) {
      this.deps.logger?.warn?.(
        { taskId: task.id, hostId: task.hostId, lastSeenAgoMs: ageMs },
        "orchestrator: running task on offline host (SP-2 session-resume will recover on host reconnect)",
      );
    }
  }

  private async maybeReapplyMergeGate(task: ProjectTask): Promise<void> {
    const project = await getProject(this.deps.db, task.projectId);
    if (!project) return;
    if (project.mergePolicy === "require-review") return; // user must act
    // Project's policy changed (or initial gate deferred for another reason)
    // — try the gate again. If it stays in reviewing we just no-op.
    let next: TaskState;
    try {
      next = await evaluateAndApplyMergeGate(
        { hostRpc: this.deps.hostRpc, logger: this.deps.logger },
        project,
        task,
      );
    } catch (err) {
      this.deps.logger?.warn?.(
        { taskId: task.id, err: String(err) },
        "orchestrator: merge gate threw during reconcile",
      );
      return;
    }
    if (next === "reviewing") return; // unchanged
    try {
      const updated = await transitionTask(this.deps.db, task.id, "reviewing", next);
      this.broadcastTask(updated, "state-changed");
      this.broadcastProject(project, "updated");
    } catch (err) {
      if (err instanceof StateMismatch) return; // another path raced us — fine
      throw err;
    }
  }

  // ─── Phase 2: dispatch ────────────────────────────────────────────────────

  private async dispatchQueuedTasks(): Promise<void> {
    // Walk active (non-archived) projects, then per-project pick eligible tasks.
    // For SP-3 single-node, scanning every project on every tick is cheap.
    const projectRows = await this.deps.db
      .select()
      .from(projectsTable)
      .where(isNull(projectsTable.archivedAt));
    // Re-fetch via getProject path for consistent camelCase shape.
    for (const pr of projectRows) {
      const project = await getProject(this.deps.db, pr.id);
      if (!project) continue;
      if (project.archivedAt) continue;
      await this.dispatchForProject(project);
    }
  }

  private async dispatchForProject(project: Project): Promise<void> {
    // Running headcount for this project.
    const allTasks = await this.deps.db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.projectId, project.id));
    const runningCount = allTasks.filter((t) =>
      t.state === "running" || t.state === "needs-input",
    ).length;
    let slots = project.concurrencyLimit - runningCount;
    if (slots <= 0) return;

    // Queued tasks ordered by priority desc, orderIndex asc, createdAt asc.
    const queued = allTasks
      .filter((t) => t.state === "queued")
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        if (a.orderIndex !== b.orderIndex) {
          // orderIndex is a lex-sortable decimal string; numeric parse for
          // correctness when strings differ in length ("10" < "9" lex-wise).
          const na = parseFloat(a.orderIndex);
          const nb = parseFloat(b.orderIndex);
          if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
          return a.orderIndex.localeCompare(b.orderIndex);
        }
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

    for (const row of queued) {
      if (slots <= 0) break;
      const task = await this.fetchTaskById(row.id);
      if (!task || task.state !== "queued") continue;
      const dispatched = await this.tryDispatchTask(project, task);
      if (dispatched) slots--;
    }
  }

  /**
   * Returns true if the task was successfully moved queued→running.
   * Transient failures (host offline, RPC error) return false and the task
   * stays queued for the next tick.
   */
  private async tryDispatchTask(project: Project, task: ProjectTask): Promise<boolean> {
    // Unconsumed human comments to fold into this dispatch (declared at
    // function scope so we can stamp them with the run id after createTaskRun).
    let unconsumed: TaskComment[] = [];
    // SP-3+1: per-task host override falls back to the project default.
    const hostId = task.hostId ?? project.defaultHostId;
    const branchName = `task/${task.ref.toLowerCase()}`;
    // Per-task worktree lives under `<repo>/.worktrees/<ref>`. The leading
    // slash is required — without it the path resolves OUTSIDE repoPath
    // (e.g. `/Users/x/code/test.worktrees/T-1` not `…/test/.worktrees/T-1`),
    // and the host's `assertWorktreeInRepo` safety check correctly rejects it.
    const worktreePath = `${project.repoPath}/.worktrees/${task.ref}`;

    try {
      await this.deps.hostRpc.gitInitIfMissing(hostId, {
        repoPath: project.repoPath,
      });
      await this.deps.hostRpc.gitWorktreeCreate(hostId, {
        repoPath: project.repoPath,
        branchName,
        worktreePath,
      });
    } catch (err) {
      if (err instanceof HostRpcError && err.code === "host-offline") {
        // Don't escalate — wait for host to come back.
        this.deps.logger?.debug?.(
          { projectId: project.id, taskId: task.id, hostId },
          "orchestrator: skipping dispatch (host offline)",
        );
        return false;
      }
      this.deps.logger?.warn?.(
        { projectId: project.id, taskId: task.id, hostId, err: String(err) },
        "orchestrator: git RPC failed during dispatch (will retry next tick)",
      );
      return false;
    }

    // The task's `executionThreadId` is what the runner will stream events
    // into. SP-3 reuses the SP-1 threads table; the runner_session is opened
    // here against that thread. If the task doesn't yet have one, we don't
    // create one in MVP — the desktop UI's "open task drawer" path or the
    // explicit POST /tasks/:id/start (Track C) seeds it. For dispatch to
    // proceed without a thread, we open the runner_session against a thread
    // we create lazily here so SP-1's event path has somewhere to write.
    //
    // To keep the orchestrator's scope tight, we require an executionThreadId
    // to exist; if not, skip and let the use-case-level path (Track C
    // createTask) seed it. Tests can pre-populate it.
    if (!task.executionThreadId) {
      this.deps.logger?.warn?.(
        { taskId: task.id },
        "orchestrator: task has no executionThreadId — skipping dispatch (Track C creates this)",
      );
      return false;
    }

    const adapter = task.adapter ?? DEFAULT_ADAPTER;

    const session = await openRunnerSession(this.deps.db, {
      threadId: task.executionThreadId,
      hostId,
      adapter,
    });

    // Send the dispatch frame to the host. We go through hostRouter so the
    // host's WS sees a frame in the same exact shape SP-1 uses.
    const conn = this.deps.hostRouter.getHostByIdForUser(project.userId, hostId);
    if (!conn) {
      // Host disconnected between init/worktree calls and now — rare race.
      // Don't transition the task; let next tick retry.
      this.deps.logger?.warn?.(
        { projectId: project.id, taskId: task.id, hostId },
        "orchestrator: host vanished mid-dispatch",
      );
      return false;
    }
    try {
      // Compose the dispatch message: project system prompt (if any) +
      // file-commit operational suffix + task title/description.
      //
      // The operational suffix is mandatory and project-agnostic. Without
      // it, claude on a vague task ("贪吃蛇小游戏") tends to plan-mode +
      // paste code in chat — Accept then merges an empty branch. Telling
      // it explicitly "write files in cwd, git add, git commit before
      // reporting done" reliably switches behavior to producing real
      // artifacts. (Custom project.systemPrompt prepended above this so
      // user prompts can override / specialize.)
      const FILE_COMMIT_RULES = [
        "# Operational rules for this task",
        "",
        "- Your CWD is a git worktree dedicated to this task. Treat it as the deliverable surface.",
        "- For any code/document/asset the user is asking for, **write real files** in CWD (do NOT only paste the content in chat).",
        "- When done implementing, run `git add -A && git commit -m \"<concise summary>\"` before reporting completion.",
        "- Do not ask the user clarifying questions with AskUserQuestion. If details are missing, make a conservative product-minded assumption, write it down briefly in the final response, and continue.",
        "- If the task is exploratory / Q&A only (no deliverable), say so explicitly and don't force a commit.",
        "- Before reporting completion or asking a question, your FINAL message must be a structured handoff note with three short parts: (1) 做了什么 — what you did; (2) 交付物在哪 — where the deliverable is (files / branch); (3) 下一步人类该检查什么 — what the human should review next.",
        "",
      ].join("\n");
      const messageParts: string[] = [];
      if (project.systemPrompt && project.systemPrompt.trim().length > 0) {
        messageParts.push(project.systemPrompt.trim(), "");
      }
      messageParts.push(FILE_COMMIT_RULES);
      messageParts.push("# Task");
      messageParts.push("");
      messageParts.push(task.title);
      if (task.description) {
        messageParts.push("", task.description);
      }
      // Inject any inert human comments dropped since the last run as a
      // `# 人类补充说明` block — the user's notes ride into the runner's initial
      // context. They're stamped consumed below once createTaskRun gives us a
      // run id, so a later dispatch won't re-inject them.
      unconsumed = await gatherUnconsumedUserComments(this.deps.db, task.id);
      const commentBlock = renderCommentsForRunner(unconsumed);
      if (commentBlock) {
        messageParts.push("", commentBlock);
      }
      // Files attached to the folded-in comments were staged on the host under
      // this executionThreadId; carry their names so the host materializes them
      // into the worktree cwd before the runner turn (same mechanism as chat).
      const attachments = commentAttachments(unconsumed);
      const frame: CloudToHost = {
        t: "dispatch",
        sessionId: session.id,
        threadId: task.executionThreadId,
        adapter,
        runnerSessionId: session.runnerSessionId,
        message: messageParts.join("\n"),
        // SP-3 §七 invariant 3: runner cwd === task.worktreePath. The
        // worktree was created via gitWorktreeCreate above so the path is
        // guaranteed to exist on the host.
        workspacePath: worktreePath,
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      conn.send(frame);
    } catch (err) {
      this.deps.logger?.warn?.(
        { taskId: task.id, err: String(err) },
        "orchestrator: dispatch frame send failed",
      );
      return false;
    }

    // Move state + record the new attempt.
    let updated: ProjectTask;
    try {
      updated = await transitionTask(this.deps.db, task.id, "queued", "running", {
        hostId,
        adapter,
        worktreePath,
        branchName,
      });
    } catch (err) {
      if (err instanceof StateMismatch) {
        // Someone else moved the task — cancel from the user, e.g. — abandon.
        return false;
      }
      throw err;
    }
    const priorRuns = await listTaskRuns(this.deps.db, task.id);
    const run = await createTaskRun(this.deps.db, {
      taskId: task.id,
      runnerSessionId: session.id,
      attemptNumber: priorRuns.length + 1,
      startedAt: updated.startedAt ? new Date(updated.startedAt) : new Date(),
    });
    if (unconsumed.length > 0) {
      await markCommentsConsumed(this.deps.db, unconsumed.map((c) => c.id), run.id);
    }

    this.broadcastTask(updated, "state-changed");
    this.broadcastProject(project, "updated");
    return true;
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private async fetchTaskById(taskId: string): Promise<ProjectTask | null> {
    // Reuse the row-mapper in db/projects.ts to avoid drift. `getTask` would
    // pull this same row, but we import it lazily here to keep the
    // file's dep graph tight.
    const { getTask } = await import("../../db/projects.js");
    return getTask(this.deps.db, taskId);
  }

  private broadcastTask(task: ProjectTask, kind: "created" | "updated" | "deleted" | "state-changed"): void {
    this.deps.clients.broadcastTask(task.id, { t: "task-event", kind, task });
    // Project's view of the task also moves — board hooks subscribe to project,
    // not task, so push there too.
    this.deps.clients.broadcastProject(task.projectId, { t: "task-event", kind, task });
    // This is the live "task finished" path (running → done/reviewing/failed on
    // the reconcile tick). Fire a Web Push for those states; fire-and-forget,
    // the notifier filters + never throws.
    if (kind === "state-changed") void this.deps.pushNotifier?.notifyTaskStateChanged(task);
  }

  private broadcastProject(project: Project, kind: "created" | "updated" | "archived"): void {
    this.deps.clients.broadcastProjects(project.userId, {
      t: "project-event",
      kind,
      project,
    });
    this.deps.clients.broadcastProject(project.id, {
      t: "project-event",
      kind,
      project,
    });
  }
}

// Re-export lifecycle helpers + active-states for tests / direct callers.
export { ACTIVE_STATES, TICK_INTERVAL_MS, HOST_OFFLINE_THRESHOLD_MS };
