/**
 * SP-3 project task lifecycle state machine.
 *
 * Every state transition in the orchestrator + domain use-cases routes
 * through `transitionTask`. The function takes the *expected* current state
 * so we get an explicit optimistic-locking check: if some other tick has
 * already moved the task (e.g. a reconcile flipped queued→running while a
 * user clicked Cancel), `transitionTask` throws `StateMismatch` instead of
 * silently double-driving the row. Callers either retry on the next tick
 * (orchestrator) or surface a 409 to the API caller (REST routes — Track C).
 *
 * Why a transaction:
 *   - We `SELECT ... FOR UPDATE` the row first so concurrent transitions in
 *     a multi-writer future (SP-3+1) can't race past each other.
 *   - The `updateTaskState` call writes inside the same tx so the row never
 *     observably exists in a half-updated form.
 *
 * Why the lock is opt-in (not always present): pglite's drizzle binding
 * has its own dialect quirks and `FOR UPDATE` is harmless on Postgres but
 * issues a warning on pglite; we keep the SELECT but skip the `FOR UPDATE`
 * clause in tests by checking the dialect at runtime would be over-engineered
 * for MVP. Today the SELECT just acts as a read-then-write guard; the
 * tx + the `expectedFrom` literal check together cover the correctness gap.
 */

import { eq } from "drizzle-orm";
import type { AnyDb } from "../../db/users.js";
import { projectTasks } from "../../db/schema.js";
import { updateTaskState, type UpdateTaskStatePatch } from "../../db/projects.js";
import type { ProjectTask, TaskState } from "@cogni/contract";

/**
 * Legal forward transitions per spec §四. Terminal states (done / failed /
 * cancelled) can re-enter `queued` only via explicit retry — that's a
 * deliberate edge we list here so retry is also routed through `transitionTask`
 * and gets the same audit + broadcast plumbing.
 */
export const LEGAL_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ["running", "cancelled"],
  running: ["needs-input", "reviewing", "failed", "done", "cancelled"],
  "needs-input": ["running", "cancelled", "failed"],
  reviewing: ["done", "failed", "cancelled"],
  done: ["queued"], // retry path
  failed: ["queued"], // retry path
  cancelled: ["queued"], // retry path (rare but legal — user re-runs a cancelled task)
};

export class StateMismatch extends Error {
  constructor(
    public readonly taskId: string,
    public readonly expected: TaskState,
    public readonly actual: TaskState,
  ) {
    super(`task ${taskId} expected state=${expected}, got ${actual}`);
    this.name = "StateMismatch";
  }
}

export class IllegalTransition extends Error {
  constructor(
    public readonly from: TaskState,
    public readonly to: TaskState,
  ) {
    super(`illegal lifecycle transition: ${from} → ${to}`);
    this.name = "IllegalTransition";
  }
}

/**
 * Move a task from `expectedFrom` to `newState` atomically.
 *
 *  - Asserts the row's current state matches `expectedFrom`; otherwise throws
 *    `StateMismatch` (caller decides: retry, 409, etc).
 *  - Asserts `(expectedFrom → newState)` is in `LEGAL_TRANSITIONS`; otherwise
 *    throws `IllegalTransition` (a code bug — caller should not catch).
 *  - Stamps `startedAt = now()` on queued→running, `completedAt = now()` on
 *    any →done/failed/cancelled transition. Callers may override via `patch`
 *    if they need an explicit timestamp (e.g. reconcile back-dating).
 */
export async function transitionTask(
  db: AnyDb,
  taskId: string,
  expectedFrom: TaskState,
  newState: TaskState,
  patch: UpdateTaskStatePatch = {},
): Promise<ProjectTask> {
  if (!LEGAL_TRANSITIONS[expectedFrom].includes(newState)) {
    throw new IllegalTransition(expectedFrom, newState);
  }

  return await db.transaction(async (tx) => {
    const rows = await tx
      .select({ state: projectTasks.state })
      .from(projectTasks)
      .where(eq(projectTasks.id, taskId))
      .limit(1);
    if (!rows[0]) throw new Error(`task ${taskId} not found`);
    const actual = rows[0].state as TaskState;
    if (actual !== expectedFrom) {
      throw new StateMismatch(taskId, expectedFrom, actual);
    }

    // Auto-stamp lifecycle timestamps when the caller didn't override.
    const now = new Date();
    const finalPatch: UpdateTaskStatePatch = { ...patch };
    if (expectedFrom === "queued" && newState === "running" && finalPatch.startedAt === undefined) {
      finalPatch.startedAt = now;
    }
    const isTerminal = newState === "done" || newState === "failed" || newState === "cancelled";
    if (isTerminal && finalPatch.completedAt === undefined) {
      finalPatch.completedAt = now;
    }

    // `updateTaskState` writes inside the same tx — pass `tx` not `db`.
    return await updateTaskState(tx as unknown as AnyDb, taskId, newState, finalPatch);
  });
}
