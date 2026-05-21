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
import type { TaskComment, TaskState, CommentAttachment, FsBrowseResponse } from "@cogni/contract";
import { insertComment, getLatestAssistantMessage } from "../../db/task-comments.js";

export interface CommentLogger {
  warn?: (obj: Record<string, unknown>, msg: string) => void;
}

/** Minimal slice of HostRpcClient needed to walk the deliverables dir. */
export interface FsBrowseClient {
  fsBrowse(hostId: string, params: { path?: string }): Promise<FsBrowseResponse>;
}

/** Convention dir (relative to worktree/repo root) where a worker drops the
 *  user-facing deliverables it wants surfaced on the task card. Kept in sync
 *  with the dispatch prompt's "deliverables" rule in orchestrator.ts. */
export const DELIVERABLES_DIR = "deliverables";
const MAX_DELIVERABLES = 50; // cap so a runaway dir can't flood a card
const MAX_DELIVERABLES_DEPTH = 4; // bound the recursive fs-browse walk

/**
 * Snapshot the worker's user-facing deliverables for a finished task: walk
 * `<baseDir>/deliverables` over the host fs-browse RPC and return one
 * `CommentAttachment` per file, with `path` relative to `baseDir` (e.g.
 * `deliverables/report.md`) so the download route can resolve it against
 * `worktreePath ?? repoPath` later.
 *
 * Best-effort: a missing dir (most tasks produce no deliverable) or any RPC
 * error yields `[]` — it must never block a lifecycle transition.
 */
export async function collectDeliverables(
  client: FsBrowseClient,
  hostId: string,
  baseDir: string,
  logger?: CommentLogger,
): Promise<CommentAttachment[]> {
  const out: CommentAttachment[] = [];
  const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    if (out.length >= MAX_DELIVERABLES || depth > MAX_DELIVERABLES_DEPTH) return;
    let res: FsBrowseResponse;
    try {
      res = await client.fsBrowse(hostId, { path: absDir });
    } catch {
      return; // dir absent (no deliverables) or RPC failure — swallow, stay best-effort
    }
    for (const e of res.entries) {
      if (out.length >= MAX_DELIVERABLES) break;
      const rel = `${relDir}/${e.name}`;
      if (e.type === "dir") {
        await walk(`${absDir}/${e.name}`, rel, depth + 1);
      } else {
        out.push({ name: e.name, size: e.size ?? 0, path: rel });
      }
    }
  };
  try {
    await walk(`${baseDir}/${DELIVERABLES_DIR}`, DELIVERABLES_DIR, 0);
  } catch (err) {
    logger?.warn?.({ baseDir, err: String(err) }, "collectDeliverables failed");
  }
  return out;
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
    /** Deliverable files to surface on the handoff card (see collectDeliverables). */
    attachments?: CommentAttachment[];
  },
  logger?: CommentLogger,
): Promise<TaskComment | null> {
  try {
    let body = args.body?.trim() ?? "";
    if (!body && args.threadId) {
      body = (await getLatestAssistantMessage(db, args.threadId))?.trim() ?? "";
    }
    // Still post a card when there's no text but there ARE deliverables — the
    // attachments are the point of the handoff in that case.
    const attachments = args.attachments ?? [];
    if (!body && attachments.length === 0) return null;
    return await insertComment(db, {
      taskId: args.taskId,
      author: "worker",
      body,
      state: args.state,
      runnerSessionId: args.runnerSessionId ?? null,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  } catch (err) {
    logger?.warn?.({ taskId: args.taskId, err: String(err) }, "captureWorkerNote failed");
    return null;
  }
}

/** Render unconsumed user comments into a runner-context block, or null if none.
 *  A comment's attachments are named as `./.cogni-uploads/<file>` (same path the
 *  host materializes them to) so the worker knows where to read them. */
export function renderCommentsForRunner(comments: TaskComment[]): string | null {
  if (comments.length === 0) return null;
  const lines = ["# 人类补充说明", "(以下是人类在上一次运行后追加的说明,请一并考虑)", ""];
  for (const c of comments) {
    lines.push(`- ${c.body.trim()}`);
    for (const a of c.attachments ?? []) lines.push(`  - 附件: ./.cogni-uploads/${a.name}`);
  }
  return lines.join("\n");
}

/** Flatten the attachment metadata across comments for the dispatch frame, so
 *  the host materializes the staged files into the worktree before the run. */
export function commentAttachments(comments: TaskComment[]): { name: string; size: number }[] {
  return comments.flatMap((c) => c.attachments ?? []);
}
