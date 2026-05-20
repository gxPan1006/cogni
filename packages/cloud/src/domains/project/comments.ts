/**
 * SP-3 task-comment domain helpers — worker handoff-note capture + the
 * runner-context render block for unconsumed human comments.
 *
 * What the user sees: at every handoff (`done` / `reviewing` / `needs-input`)
 * a "worker" card appears in the task's 主页面 comment feed summarizing what the
 * runner just did; and when the task is next (re)dispatched, any human notes
 * the user dropped in the feed are folded into the runner's initial context as
 * a clearly-labeled `# 人类补充说明` block so the worker actually reads them.
 *
 * Both helpers are deliberately side-effect-light: `captureWorkerNote` is
 * best-effort (a failure must never block a lifecycle transition), and
 * `renderCommentsForRunner` is pure.
 */
import type { AnyDb } from "../../db/users.js";
import type { TaskComment, TaskState } from "@cogni/contract";
import { insertComment, getLatestAssistantMessage } from "../../db/task-comments.js";

export interface CommentLogger {
  warn?: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Snapshot the runner's handoff note as a `worker` comment at a transition.
 * Best-effort: a failure logs and returns null — it must never block a
 * lifecycle transition. `body` may be passed directly (e.g. the needs-input
 * question text); otherwise we read the thread's latest assistant message.
 */
export async function captureWorkerNote(
  db: AnyDb,
  args: {
    taskId: string;
    state: TaskState;
    threadId?: string | null;
    body?: string | null;
    runnerSessionId?: string | null;
  },
  logger?: CommentLogger,
): Promise<TaskComment | null> {
  try {
    let body = args.body?.trim() ?? "";
    if (!body && args.threadId) {
      body = (await getLatestAssistantMessage(db, args.threadId))?.trim() ?? "";
    }
    if (!body) return null;
    return await insertComment(db, {
      taskId: args.taskId,
      author: "worker",
      body,
      state: args.state,
      runnerSessionId: args.runnerSessionId ?? null,
    });
  } catch (err) {
    logger?.warn?.({ taskId: args.taskId, err: String(err) }, "captureWorkerNote failed");
    return null;
  }
}

/** Render unconsumed user comments into a runner-context block, or null if none. */
export function renderCommentsForRunner(comments: TaskComment[]): string | null {
  if (comments.length === 0) return null;
  const lines = ["# 人类补充说明", "(以下是人类在上一次运行后追加的说明,请一并考虑)", ""];
  for (const c of comments) lines.push(`- ${c.body.trim()}`);
  return lines.join("\n");
}
