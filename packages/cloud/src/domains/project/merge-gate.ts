/**
 * SP-3 mergePolicy gate.
 *
 * Called when a running task's runner has emitted `done` (the cloud
 * receives this via SP-1's existing event path; orchestrator detects the
 * `running` task whose latest runner_session is `completed`, then asks the
 * gate to decide what comes next).
 *
 * Three project-level policies (spec §四):
 *   - `require-review`        → human always reviews → return "reviewing"
 *   - `auto-merge`            → try `git-merge-to-main`; on success delete
 *                               the worktree and return "done"; on conflict
 *                               fall back to "reviewing" so the user can
 *                               resolve manually (worktree stays).
 *   - `auto-merge-if-tests-pass` → run project's testCommand on the worktree;
 *                                   exit 0 → run the auto-merge sub-flow;
 *                                   non-zero → "reviewing" (worktree stays).
 *
 * Why we don't transition the task ourselves: keeping the gate a pure
 * decision function (just returns the next state + side-effect log) lets the
 * orchestrator own the `transitionTask` call — that keeps state changes +
 * broadcasts in one place. The gate *does* mutate host-side state (merge,
 * worktree remove) because those are non-DB side effects coupled to the
 * decision.
 */

import type { Project, ProjectTask, TaskState } from "@cogni/contract";
import type { HostRpcClient } from "./host-rpc.js";
import { HostRpcError } from "./host-rpc.js";
import type { HostRpcLogger } from "./host-rpc.js";

export interface MergeGateDeps {
  hostRpc: HostRpcClient;
  logger?: HostRpcLogger;
}

/**
 * Decide + execute the post-running-done branch.
 *
 * Precondition (caller's responsibility): task.state === "running" and the
 * underlying runner_session has finalized (runner emitted `done`).
 *
 * Returns the *next* state the task should land in. The caller wraps this
 * in `transitionTask(taskId, "running", <returned>)`.
 */
export async function evaluateAndApplyMergeGate(
  deps: MergeGateDeps,
  project: Project,
  task: ProjectTask,
): Promise<TaskState> {
  // require-review: trivial path, no host calls.
  if (project.mergePolicy === "require-review") {
    return "reviewing";
  }

  // The remaining two policies need the worktree + branch info on the task.
  // If those are absent (orchestrator bug or test fixture), we fall back to
  // reviewing rather than do something destructive with a half-populated row.
  if (!task.hostId || !task.worktreePath || !task.branchName) {
    deps.logger?.warn?.(
      { taskId: task.id, hostId: task.hostId, worktreePath: task.worktreePath, branchName: task.branchName },
      "merge-gate: task missing host/worktree/branch — falling back to reviewing",
    );
    return "reviewing";
  }

  if (project.mergePolicy === "auto-merge-if-tests-pass") {
    if (!project.testCommand) {
      // Misconfigured project: policy says run tests but no command stored.
      // Don't auto-pass; defer to human.
      deps.logger?.warn?.({ projectId: project.id }, "merge-gate: auto-merge-if-tests-pass with no testCommand");
      return "reviewing";
    }
    try {
      const testResult = await deps.hostRpc.gitTestsRun(task.hostId, {
        worktreePath: task.worktreePath,
        command: project.testCommand,
        timeoutMs: 10 * 60_000, // 10min cap
      });
      if (testResult.exitCode !== 0) {
        deps.logger?.warn?.(
          { taskId: task.id, exitCode: testResult.exitCode },
          "merge-gate: tests failed — falling back to reviewing",
        );
        return "reviewing";
      }
    } catch (err) {
      // Host error / timeout running tests → don't auto-merge; let human inspect.
      deps.logger?.warn?.(
        { taskId: task.id, err: err instanceof HostRpcError ? err.message : String(err) },
        "merge-gate: tests-run RPC failed — falling back to reviewing",
      );
      return "reviewing";
    }
    // Tests passed — fall through to the auto-merge path.
  }

  // auto-merge (either chosen directly or reached via tests-pass).
  try {
    const mergeResult = await deps.hostRpc.gitMergeToMain(task.hostId, {
      repoPath: project.repoPath,
      branchName: task.branchName,
      commitMessage: `cogni: merge task ${task.ref} (${task.title})`,
    });
    if (!mergeResult.ok) {
      deps.logger?.warn?.(
        { taskId: task.id, message: mergeResult.message },
        "merge-gate: merge-to-main returned ok=false — falling back to reviewing",
      );
      return "reviewing";
    }
  } catch (err) {
    deps.logger?.warn?.(
      { taskId: task.id, err: err instanceof HostRpcError ? err.message : String(err) },
      "merge-gate: merge-to-main RPC threw — falling back to reviewing",
    );
    return "reviewing";
  }

  // Merge succeeded — clean up the worktree. Failure here is non-fatal; the
  // task is still functionally done, just leaves a stale worktree on disk
  // (orchestrator's reconcile pass will retry on a later tick if we add that).
  try {
    await deps.hostRpc.gitWorktreeRemove(task.hostId, {
      worktreePath: task.worktreePath,
      force: false,
      // Branch is already merged into main above; clean it up too (git -d).
      repoPath: project.repoPath,
      branchName: task.branchName,
    });
  } catch (err) {
    deps.logger?.warn?.(
      { taskId: task.id, err: err instanceof HostRpcError ? err.message : String(err) },
      "merge-gate: worktree-remove post-merge failed; leaving stale worktree",
    );
  }

  return "done";
}
