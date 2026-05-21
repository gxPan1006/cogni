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
  /**
   * SP-3: repo root, needed to delete the task branch after the worktree is
   * gone. Branch deletion can't happen while the worktree still has the
   * branch checked out (git refuses), so it's deferred to here rather than
   * done inside git-merge-to-main. Optional — omit to skip branch cleanup.
   */
  repoPath: z.string().optional(),
  /**
   * SP-3: the task branch to delete once the worktree is removed. Uses
   * `git branch -d` when `force` is false (refuses if unmerged — the
   * accept/auto-merge path, branch is already merged) or `-D` when `force`
   * is true (the reject/cancel path, discard unmerged work). No-op if absent.
   */
  branchName: z.string().optional(),
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

// git-push-to-remote (SP-3+1: project.pushToRemote=true → push main after merge)
export const gitPushToRemoteRequestSchema = z.object({
  repoPath: z.string(),
  /** Branch to push (always "main" today; carried explicitly for clarity). */
  branch: z.string(),
  /** Remote name; defaults to "origin" host-side if absent. */
  remote: z.string().optional(),
});
export type GitPushToRemoteRequest = z.infer<typeof gitPushToRemoteRequestSchema>;

export const gitPushToRemoteResponseSchema = z.object({
  ok: z.boolean(),
  /** stderr tail when ok=false: no remote configured, auth failure, rejected push, etc. */
  message: z.string().optional(),
});
export type GitPushToRemoteResponse = z.infer<typeof gitPushToRemoteResponseSchema>;

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

// generate-thread-title
// Spawn the host-local "small model" CLI (currently `claude --print --model
// claude-haiku-4-5`) and ask for a short title summarising the user's first
// turn. The host owns the model + CLI specifics so the cloud doesn't need
// its own API key; the response is just a trimmed string.
export const generateThreadTitleRequestSchema = z.object({
  /** The runner adapter the chat is using (e.g. "claude-code"). Lets the
   *  host pick a matching CLI / model — for now only claude-code is supported. */
  adapter: z.string(),
  /** Verbatim first user message. */
  userMessage: z.string(),
  /** Final assistant reply text (concatenated `text` events). May be empty
   *  if the assistant produced only tool calls; host should still try. */
  assistantReply: z.string(),
});
export type GenerateThreadTitleRequest = z.infer<typeof generateThreadTitleRequestSchema>;

export const generateThreadTitleResponseSchema = z.object({
  /** Already trimmed, single-line, no surrounding quotes. Cloud writes this
   *  straight into threads.title — keep ≤ 60 chars on the host side. */
  title: z.string().min(1).max(120),
});
export type GenerateThreadTitleResponse = z.infer<typeof generateThreadTitleResponseSchema>;

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

// read-file (SP-4 Artifacts: stream a host file's bytes to a thin client)
export const readFileRequestSchema = z.object({
  /** Absolute path on the host. The cloud route is responsible for confining
   *  this to an allowed root (project repo / thread scratch dir) before
   *  calling — the host only enforces the byte cap + that it's a real file. */
  path: z.string(),
  /** Max bytes to read; host returns truncated:true if the file is larger.
   *  Defaults host-side (10 MB) when omitted. */
  maxBytes: z.number().int().positive().optional(),
});
export type ReadFileRequest = z.infer<typeof readFileRequestSchema>;

export const readFileResponseSchema = z.object({
  /** File contents, base64-encoded (binary-safe over the JSON WS frame). */
  contentBase64: z.string(),
  /** Actual file size on disk in bytes (may exceed the returned slice). */
  size: z.number().int().min(0),
  /** True when the file was larger than maxBytes and contentBase64 is a prefix. */
  truncated: z.boolean(),
});
export type ReadFileResponse = z.infer<typeof readFileResponseSchema>;

// ─── File upload (agent-context attachments) ────────────────────────────────
// Inbound counterpart to read-file. The cloud streams an HTTP upload to the
// host in base64 chunks; the host stages the file under
// ~/.cogni/uploads/<threadId>/ and the runner-manager copies this turn's files
// into <cwd>/.cogni-uploads/ at dispatch. 50MB cap enforced cumulatively host-side.

export const uploadScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: z.string() }),
]);
export type UploadScope = z.infer<typeof uploadScopeSchema>;

export const uploadBeginRequestSchema = z.object({
  scope: uploadScopeSchema,
  /** Original client filename; host reduces to basename + de-dupes. */
  fileName: z.string(),
  /** Client-declared size for a fast pre-check; host enforces the real cap on bytes written. */
  declaredSize: z.number().int().min(0),
});
export type UploadBeginRequest = z.infer<typeof uploadBeginRequestSchema>;

export const uploadBeginResponseSchema = z.object({ uploadId: z.string() });
export type UploadBeginResponse = z.infer<typeof uploadBeginResponseSchema>;

export const uploadChunkRequestSchema = z.object({
  uploadId: z.string(),
  seq: z.number().int().min(0),
  /** One chunk of the file, base64-encoded (binary-safe over the JSON WS frame). */
  dataBase64: z.string(),
});
export type UploadChunkRequest = z.infer<typeof uploadChunkRequestSchema>;

export const uploadChunkResponseSchema = z.object({ received: z.number().int().min(0) });
export type UploadChunkResponse = z.infer<typeof uploadChunkResponseSchema>;

export const uploadCommitRequestSchema = z.object({ uploadId: z.string() });
export type UploadCommitRequest = z.infer<typeof uploadCommitRequestSchema>;

export const uploadCommitResponseSchema = z.object({
  /** Path relative to the agent cwd, e.g. ".cogni-uploads/foo.pdf". */
  relPath: z.string(),
  /** Final (possibly de-duped) basename, e.g. "foo-1.pdf". */
  name: z.string(),
  size: z.number().int().min(0),
});
export type UploadCommitResponse = z.infer<typeof uploadCommitResponseSchema>;

export const uploadAbortRequestSchema = z.object({ uploadId: z.string() });
export type UploadAbortRequest = z.infer<typeof uploadAbortRequestSchema>;

export const uploadAbortResponseSchema = z.object({ ok: z.literal(true) });
export type UploadAbortResponse = z.infer<typeof uploadAbortResponseSchema>;

// set-projects-root — configurable per-host root for auto-created project folders
export const setProjectsRootRequestSchema = z.object({
  /** New root; may contain a leading ~ (host expands it). */
  projectsRoot: z.string().min(1),
});
export type SetProjectsRootRequest = z.infer<typeof setProjectsRootRequestSchema>;

export const setProjectsRootResponseSchema = z.object({
  /** Absolute, ~-expanded path the host will use. */
  projectsRoot: z.string(),
  /** true ⇢ pinned by COGNI_PROJECTS_ROOT env; the write was a no-op. */
  locked: z.boolean(),
});
export type SetProjectsRootResponse = z.infer<typeof setProjectsRootResponseSchema>;

// set-keep-awake — toggle whether the host blocks OS sleep while the daemon runs
export const setKeepAwakeRequestSchema = z.object({
  /** true ⇢ hold a sleep assertion; false ⇢ release it. */
  enabled: z.boolean(),
});
export type SetKeepAwakeRequest = z.infer<typeof setKeepAwakeRequestSchema>;

export const setKeepAwakeResponseSchema = z.object({
  /** Effective state the host will use (may differ from request when locked). */
  enabled: z.boolean(),
  /** true ⇢ pinned by COGNI_KEEP_AWAKE env; the write was a no-op. */
  locked: z.boolean(),
});
export type SetKeepAwakeResponse = z.infer<typeof setKeepAwakeResponseSchema>;

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
  z.object({ method: z.literal("git-push-to-remote"), params: gitPushToRemoteRequestSchema }),
  z.object({ method: z.literal("git-tests-run"), params: gitTestsRunRequestSchema }),
  z.object({ method: z.literal("git-diff-snapshot"), params: gitDiffSnapshotRequestSchema }),
  z.object({ method: z.literal("fs-browse"), params: fsBrowseRequestSchema }),
  z.object({ method: z.literal("generate-thread-title"), params: generateThreadTitleRequestSchema }),
  z.object({ method: z.literal("read-file"), params: readFileRequestSchema }),
  z.object({ method: z.literal("upload-begin"), params: uploadBeginRequestSchema }),
  z.object({ method: z.literal("upload-chunk"), params: uploadChunkRequestSchema }),
  z.object({ method: z.literal("upload-commit"), params: uploadCommitRequestSchema }),
  z.object({ method: z.literal("upload-abort"), params: uploadAbortRequestSchema }),
  z.object({ method: z.literal("set-projects-root"), params: setProjectsRootRequestSchema }),
  z.object({ method: z.literal("set-keep-awake"), params: setKeepAwakeRequestSchema }),
]);
export type HostRpcRequest = z.infer<typeof hostRpcRequestSchema>;

export const hostRpcMethodSchema = z.enum([
  "git-init-if-missing",
  "git-worktree-create",
  "git-worktree-remove",
  "git-merge-to-main",
  "git-push-to-remote",
  "git-tests-run",
  "git-diff-snapshot",
  "fs-browse",
  "generate-thread-title",
  "read-file",
  "upload-begin",
  "upload-chunk",
  "upload-commit",
  "upload-abort",
  "set-projects-root",
  "set-keep-awake",
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
  z.object({ ok: z.literal(true), method: z.literal("git-push-to-remote"), result: gitPushToRemoteResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("git-tests-run"), result: gitTestsRunResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("git-diff-snapshot"), result: gitDiffSnapshotResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("fs-browse"), result: fsBrowseResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("generate-thread-title"), result: generateThreadTitleResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("read-file"), result: readFileResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("upload-begin"), result: uploadBeginResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("upload-chunk"), result: uploadChunkResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("upload-commit"), result: uploadCommitResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("upload-abort"), result: uploadAbortResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("set-projects-root"), result: setProjectsRootResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("set-keep-awake"), result: setKeepAwakeResponseSchema }),
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
  "git-push-to-remote",
  "git-tests-run",
  "git-diff-snapshot",
  "fs-browse",
  "generate-thread-title",
  "read-file",
  "upload-begin",
  "upload-chunk",
  "upload-commit",
  "upload-abort",
  "set-projects-root",
  "set-keep-awake",
] as const;
export type HostRpcMethod = (typeof HOST_RPC_METHODS)[number];
