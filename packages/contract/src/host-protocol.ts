/**
 * SP-3 cloud → host RPC protocol.
 *
 * SP-1/SP-2 had only one cloud→host message path: `dispatch` (start a
 * runner session) plus host-originated heartbeat/event/session-update.
 * SP-3 introduces an RPC surface for project domain operations the host
 * must own because they touch the user's local disk + git repo:
 *
 *   - git-init-if-missing   bootstrap a fresh repo at projectRoot
 *   - git-worktree-create   create the per-task worktree + branch
 *   - git-worktree-remove   destroy worktree (terminal task state)
 *   - git-merge-to-main     reviewing → done acceptance path
 *   - git-tests-run         auto-merge-if-tests-pass policy gate
 *   - git-diff-snapshot     drawer "Review" tab + accept/reject UI
 *   - fs-browse             web NewProject "📁 Browse" step on remote host
 *
 * Each RPC is request/response. The cloud assigns an `rpcId` and the
 * host echoes it on the response frame so multiple in-flight RPCs over
 * the single WS multiplex correctly. (The framing envelope itself lives
 * in `protocol.ts`'s `cloudToHostSchema` / `hostToCloudSchema`; this
 * file only defines the typed payloads.)
 *
 * Safety invariants (host MUST enforce, spec §七):
 *   1. `worktreePath` must live under `repoPath`
 *   2. `repoPath` must be a valid git repo (rev-parse passes) — or
 *      `git-init-if-missing` is being called first
 *   3. runner cwd === task.worktreePath (asserted before spawn)
 *   4. `fs-browse` only lists directory entries; never reveals file bodies
 */

import { z } from "zod";

// ─── Per-RPC payload schemas (request + response) ───────────────────────────

// git-init-if-missing
export const gitInitIfMissingRequestSchema = z.object({
  repoPath: z.string(),
  /** Optional first-commit README so the repo has a HEAD; host may skip if file exists. */
  initialReadme: z.string().optional(),
});
export type GitInitIfMissingRequest = z.infer<typeof gitInitIfMissingRequestSchema>;

export const gitInitIfMissingResponseSchema = z.object({
  /** true ⇢ host ran `git init`; false ⇢ already a repo, no-op. */
  initialized: z.boolean(),
});
export type GitInitIfMissingResponse = z.infer<typeof gitInitIfMissingResponseSchema>;

// git-worktree-create
export const gitWorktreeCreateRequestSchema = z.object({
  repoPath: z.string(),
  branchName: z.string(),
  worktreePath: z.string(),
});
export type GitWorktreeCreateRequest = z.infer<typeof gitWorktreeCreateRequestSchema>;

export const gitWorktreeCreateResponseSchema = z.object({
  /** Absolute path host actually created; usually echoes request.worktreePath. */
  worktreePath: z.string(),
});
export type GitWorktreeCreateResponse = z.infer<typeof gitWorktreeCreateResponseSchema>;

// git-worktree-remove
export const gitWorktreeRemoveRequestSchema = z.object({
  worktreePath: z.string(),
  /** If true, pass `--force` to `git worktree remove`. SP-3 reviewing→reject sends true. */
  force: z.boolean(),
});
export type GitWorktreeRemoveRequest = z.infer<typeof gitWorktreeRemoveRequestSchema>;

export const gitWorktreeRemoveResponseSchema = z.object({
  /** false ⇢ worktree did not exist or was already cleaned. Idempotent. */
  removed: z.boolean(),
});
export type GitWorktreeRemoveResponse = z.infer<typeof gitWorktreeRemoveResponseSchema>;

// git-merge-to-main
export const gitMergeToMainRequestSchema = z.object({
  repoPath: z.string(),
  branchName: z.string(),
  /** Optional `-m` for `git merge --no-ff`. Host falls back to a default if absent. */
  commitMessage: z.string().optional(),
});
export type GitMergeToMainRequest = z.infer<typeof gitMergeToMainRequestSchema>;

export const gitMergeToMainResponseSchema = z.object({
  ok: z.boolean(),
  /** Conflict summary or stderr tail when ok=false; helps the UI explain failure. */
  message: z.string().optional(),
});
export type GitMergeToMainResponse = z.infer<typeof gitMergeToMainResponseSchema>;

// git-tests-run
export const gitTestsRunRequestSchema = z.object({
  worktreePath: z.string(),
  command: z.string(),
  timeoutMs: z.number().int().positive(),
});
export type GitTestsRunRequest = z.infer<typeof gitTestsRunRequestSchema>;

/**
 * Test output streams are truncated to the trailing ~10KB on the host
 * side to keep WS frames bounded. Front of the buffer is dropped, not
 * the tail — failures usually print the diagnostic last. UI may render
 * a "(truncated)" hint if total length > tail length.
 */
export const gitTestsRunResponseSchema = z.object({
  exitCode: z.number().int(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
});
export type GitTestsRunResponse = z.infer<typeof gitTestsRunResponseSchema>;

// git-diff-snapshot
export const gitDiffSnapshotRequestSchema = z.object({
  worktreePath: z.string(),
});
export type GitDiffSnapshotRequest = z.infer<typeof gitDiffSnapshotRequestSchema>;

export const gitDiffSnapshotResponseSchema = z.object({
  /** Full unified diff against the worktree's base branch. Caller renders. */
  diff: z.string(),
  stats: z.object({
    files: z.number().int().min(0),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
  }),
});
export type GitDiffSnapshotResponse = z.infer<typeof gitDiffSnapshotResponseSchema>;

// fs-browse
export const fsBrowseRequestSchema = z.object({
  /** Absolute path on the host. If unset, host picks a sensible default (e.g. $HOME). */
  path: z.string().optional(),
});
export type FsBrowseRequest = z.infer<typeof fsBrowseRequestSchema>;

export const fsBrowseEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["file", "dir"]),
  /** File size in bytes; omitted for directories. */
  size: z.number().int().min(0).optional(),
});
export type FsBrowseEntry = z.infer<typeof fsBrowseEntrySchema>;

export const fsBrowseResponseSchema = z.object({
  entries: z.array(fsBrowseEntrySchema),
  /** The absolute path the host actually listed (path resolution may canonicalize). */
  cwd: z.string(),
});
export type FsBrowseResponse = z.infer<typeof fsBrowseResponseSchema>;

// ─── Discriminated unions for typed dispatch ────────────────────────────────

/**
 * Cloud → host RPC request envelope. The `method` literal selects which
 * `params` shape applies. Host handler dispatches via switch on `method`;
 * TypeScript narrows `params` correctly inside each arm.
 */
export const hostRpcRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("git-init-if-missing"), params: gitInitIfMissingRequestSchema }),
  z.object({ method: z.literal("git-worktree-create"), params: gitWorktreeCreateRequestSchema }),
  z.object({ method: z.literal("git-worktree-remove"), params: gitWorktreeRemoveRequestSchema }),
  z.object({ method: z.literal("git-merge-to-main"), params: gitMergeToMainRequestSchema }),
  z.object({ method: z.literal("git-tests-run"), params: gitTestsRunRequestSchema }),
  z.object({ method: z.literal("git-diff-snapshot"), params: gitDiffSnapshotRequestSchema }),
  z.object({ method: z.literal("fs-browse"), params: fsBrowseRequestSchema }),
]);
export type HostRpcRequest = z.infer<typeof hostRpcRequestSchema>;

export const hostRpcMethodSchema = z.enum([
  "git-init-if-missing",
  "git-worktree-create",
  "git-worktree-remove",
  "git-merge-to-main",
  "git-tests-run",
  "git-diff-snapshot",
  "fs-browse",
]);

/**
 * Host → cloud RPC response. A plain `z.union` of typed success branches
 * (one per method) and a single error branch. We don't use
 * `discriminatedUnion` here because both success and error variants share
 * the `method` literal and zod's `discriminatedUnion` forbids duplicate
 * discriminator values. The plain union still narrows via the type guard
 * `response.ok === true` (each success branch sets `ok: true`).
 *
 * Errors are recoverable from the orchestrator's POV — the cloud just
 * surfaces them; the lifecycle decides whether to retry/cancel.
 */
export const hostRpcResponseSchema = z.union([
  z.object({ ok: z.literal(true), method: z.literal("git-init-if-missing"), result: gitInitIfMissingResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("git-worktree-create"), result: gitWorktreeCreateResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("git-worktree-remove"), result: gitWorktreeRemoveResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("git-merge-to-main"), result: gitMergeToMainResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("git-tests-run"), result: gitTestsRunResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("git-diff-snapshot"), result: gitDiffSnapshotResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("fs-browse"), result: fsBrowseResponseSchema }),
  z.object({
    ok: z.literal(false),
    method: hostRpcMethodSchema,
    error: z.object({
      code: z.string(),
      message: z.string(),
    }),
  }),
]);
export type HostRpcResponse = z.infer<typeof hostRpcResponseSchema>;

/**
 * Convenience: the set of all RPC method literals. Useful for runtime
 * registration loops on the host (`for (const m of HOST_RPC_METHODS)`).
 */
export const HOST_RPC_METHODS = [
  "git-init-if-missing",
  "git-worktree-create",
  "git-worktree-remove",
  "git-merge-to-main",
  "git-tests-run",
  "git-diff-snapshot",
  "fs-browse",
] as const;
export type HostRpcMethod = (typeof HOST_RPC_METHODS)[number];
