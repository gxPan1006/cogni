/**
 * SP-3 host-side git RPC handlers.
 *
 * Six git ops the cloud delegates to the host because they touch the user's
 * local disk + git working tree (the cloud has no FS access to the host):
 *
 *   - gitInitIfMissing   bootstrap a fresh repo at projectRoot
 *   - gitWorktreeCreate  create the per-task worktree + branch
 *   - gitWorktreeRemove  destroy a worktree (terminal task state)
 *   - gitMergeToMain     accept a reviewing task → fast-forward / no-ff merge
 *   - gitTestsRun        execute a user-configured test command in the worktree
 *   - gitDiffSnapshot    snapshot the worktree's diff vs main for the UI
 *
 * Every handler enforces the two safety invariants from spec §七:
 *   1. If both `repoPath` and `worktreePath` are present, the worktree path
 *      MUST resolve under the repo path (otherwise we'd let cloud-controlled
 *      strings touch arbitrary disk locations).
 *   2. `repoPath` MUST already be a git repo (`git rev-parse --git-dir` passes),
 *      except for `gitInitIfMissing` which is allowed to bootstrap.
 *
 * Handlers return plain `result` payloads matching the per-method
 * `*ResponseSchema` from `@cogni/contract`. They throw `GitOpError` (with a
 * `code` field) on safety/operational failure; the dispatcher converts those
 * into `{ ok: false, error: { code, message } }` frames.
 */

import { access, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { execa } from "execa";
import type {
  GitInitIfMissingRequest,
  GitInitIfMissingResponse,
  GitWorktreeCreateRequest,
  GitWorktreeCreateResponse,
  GitWorktreeRemoveRequest,
  GitWorktreeRemoveResponse,
  GitMergeToMainRequest,
  GitMergeToMainResponse,
  GitTestsRunRequest,
  GitTestsRunResponse,
  GitDiffSnapshotRequest,
  GitDiffSnapshotResponse,
} from "@cogni/contract";

/** Operational error thrown by handlers; dispatcher serialises `code` + `message`. */
export class GitOpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "GitOpError";
  }
}

/** Per-stream tail used by `gitTestsRun` to bound WS frame size. */
const TEST_OUTPUT_TAIL_BYTES = 10 * 1024;

/** Hard cap for `gitDiffSnapshot.diff` — long binary diffs would blow WS. */
const DIFF_MAX_BYTES = 200 * 1024;

// ─── Safety helpers ────────────────────────────────────────────────────────

/** Invariant 1 — worktreePath must live under repoPath (after path resolution). */
function assertWorktreeInRepo(repoPath: string, worktreePath: string): void {
  const repo = resolve(repoPath);
  const wt = resolve(worktreePath);
  // The worktree must equal the repo or sit underneath it; we compare with a
  // trailing separator so `/r/x-foo` is not treated as a child of `/r/x`.
  if (wt !== repo && !wt.startsWith(repo + sep)) {
    throw new GitOpError(
      "worktree-outside-repo",
      `worktreePath ${wt} is not under repoPath ${repo}`,
    );
  }
}

/** Invariant 2 — repoPath must be a git repo (rev-parse passes). */
async function assertIsGitRepo(repoPath: string): Promise<void> {
  const r = await execa("git", ["-C", repoPath, "rev-parse", "--git-dir"], { reject: false });
  if (r.exitCode !== 0) {
    throw new GitOpError(
      "not-a-git-repo",
      `${repoPath} is not a git repository (rev-parse failed)`,
    );
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Keep at most `maxBytes` from the trailing end of a buffer, as a UTF-8 string. */
function tailBytes(buf: Buffer, maxBytes: number): string {
  if (buf.byteLength <= maxBytes) return buf.toString("utf8");
  return buf.subarray(buf.byteLength - maxBytes).toString("utf8");
}

// ─── Handler 1: gitInitIfMissing ───────────────────────────────────────────

/**
 * Bootstrap a fresh repo at `repoPath`. If `.git` already exists, no-op.
 * Always lands on a HEAD commit so subsequent `git worktree add -b` works.
 */
export async function gitInitIfMissing(
  req: GitInitIfMissingRequest,
): Promise<GitInitIfMissingResponse> {
  const repoPath = resolve(req.repoPath);
  if (await pathExists(`${repoPath}${sep}.git`)) {
    return { initialized: false };
  }
  // Confirm the parent directory exists; if not, we let `git init` fail
  // with its own error (more helpful than a manufactured one).
  await execa("git", ["init", "-b", "main", repoPath], { reject: true });
  // Make an empty initial commit so `worktree add -b` has a valid HEAD.
  // `--allow-empty` avoids requiring a tracked file.
  await execa(
    "git",
    ["-C", repoPath, "commit", "--allow-empty", "-m", "initial commit (cogni)"],
    {
      reject: true,
      // Keep the commit traceable but don't depend on the user's git identity.
      env: {
        GIT_AUTHOR_NAME: "cogni",
        GIT_AUTHOR_EMAIL: "cogni@localhost",
        GIT_COMMITTER_NAME: "cogni",
        GIT_COMMITTER_EMAIL: "cogni@localhost",
      },
    },
  );
  return { initialized: true };
}

// ─── Handler 2: gitWorktreeCreate ──────────────────────────────────────────

/** Create a new per-task worktree + branch. Safety: worktree must live under repo. */
export async function gitWorktreeCreate(
  req: GitWorktreeCreateRequest,
): Promise<GitWorktreeCreateResponse> {
  assertWorktreeInRepo(req.repoPath, req.worktreePath);
  await assertIsGitRepo(req.repoPath);
  const r = await execa(
    "git",
    ["-C", req.repoPath, "worktree", "add", "-b", req.branchName, req.worktreePath],
    { reject: false },
  );
  if (r.exitCode !== 0) {
    throw new GitOpError(
      "worktree-create-failed",
      r.stderr || `git worktree add exited ${r.exitCode}`,
    );
  }
  return { worktreePath: resolve(req.worktreePath) };
}

// ─── Handler 3: gitWorktreeRemove ──────────────────────────────────────────

/**
 * Remove a worktree. Idempotent: returns `removed: false` if the directory
 * isn't there at all. `force: true` adds `--force` (used by reviewing→reject).
 *
 * Contract carries only `worktreePath`, not `repoPath`. `git worktree remove`
 * works without a repo handle as long as you `cd` into the worktree itself
 * — so we run it from inside `worktreePath` rather than via `-C <repo>`.
 */
export async function gitWorktreeRemove(
  req: GitWorktreeRemoveRequest,
): Promise<GitWorktreeRemoveResponse> {
  const wt = resolve(req.worktreePath);
  if (!(await pathExists(wt))) {
    return { removed: false };
  }
  const args = ["worktree", "remove"];
  if (req.force) args.push("--force");
  args.push(wt);
  const r = await execa("git", args, { cwd: wt, reject: false });
  if (r.exitCode !== 0) {
    throw new GitOpError(
      "worktree-remove-failed",
      r.stderr || `git worktree remove exited ${r.exitCode}`,
    );
  }
  return { removed: true };
}

// ─── Handler 4: gitMergeToMain ─────────────────────────────────────────────

/**
 * Merge a task branch into main with `--no-ff`. Returns `ok: false` on
 * merge conflict (the spec lifecycle treats this as "review failed", not a
 * hard error). On real failures (missing branch, bad repo state) throws.
 */
export async function gitMergeToMain(
  req: GitMergeToMainRequest,
): Promise<GitMergeToMainResponse> {
  await assertIsGitRepo(req.repoPath);
  const checkout = await execa("git", ["-C", req.repoPath, "checkout", "main"], {
    reject: false,
  });
  if (checkout.exitCode !== 0) {
    throw new GitOpError(
      "checkout-main-failed",
      checkout.stderr || `git checkout main exited ${checkout.exitCode}`,
    );
  }
  const message = req.commitMessage ?? `Merge branch '${req.branchName}'`;
  const merge = await execa(
    "git",
    ["-C", req.repoPath, "merge", "--no-ff", "-m", message, req.branchName],
    {
      reject: false,
      env: {
        GIT_AUTHOR_NAME: "cogni",
        GIT_AUTHOR_EMAIL: "cogni@localhost",
        GIT_COMMITTER_NAME: "cogni",
        GIT_COMMITTER_EMAIL: "cogni@localhost",
      },
    },
  );
  if (merge.exitCode !== 0) {
    // Conflict (or other recoverable failure) → return ok:false rather than
    // throw, matching spec §四 "merge fails → drop back to reviewing".
    // Aborting cleans up the in-progress merge state so callers can retry.
    await execa("git", ["-C", req.repoPath, "merge", "--abort"], { reject: false });
    return {
      ok: false,
      message: merge.stderr || merge.stdout || "merge failed",
    };
  }
  // Delete the merged branch — leaves the repo tidy. `-d` (not `-D`) refuses
  // if not merged; that's the right safety behavior here.
  await execa("git", ["-C", req.repoPath, "branch", "-d", req.branchName], { reject: false });
  return { ok: true };
}

// ─── Handler 5: gitTestsRun ────────────────────────────────────────────────

/**
 * Run a user-configured shell command in the worktree. Captures stdout/stderr
 * tails (last 10KB each) and the exit code. On timeout, kills the child and
 * reports exitCode 124 (matching coreutils `timeout`).
 *
 * SECURITY NOTE: `command` is a user-provided shell string by design — the
 * test command is configured by the project owner and runs in the worktree.
 * We pass `shell: true` deliberately; the host is the user's machine so this
 * is no broader than what the runner adapter does.
 */
export async function gitTestsRun(req: GitTestsRunRequest): Promise<GitTestsRunResponse> {
  const wt = resolve(req.worktreePath);
  if (!(await pathExists(wt))) {
    throw new GitOpError("worktree-not-found", `worktreePath ${wt} does not exist`);
  }
  const child = execa(req.command, {
    cwd: wt,
    shell: true,
    reject: false,
    timeout: req.timeoutMs,
    // Buffer stdout/stderr so we can slice the tail. execa caps at 100MB by
    // default; 10KB tails are well within that.
    all: false,
  });
  const result = await child;
  const stdoutBuf = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(String(result.stdout ?? ""), "utf8");
  const stderrBuf = Buffer.isBuffer(result.stderr)
    ? result.stderr
    : Buffer.from(String(result.stderr ?? ""), "utf8");
  const stdoutTail = tailBytes(stdoutBuf, TEST_OUTPUT_TAIL_BYTES);
  const stderrTail = tailBytes(stderrBuf, TEST_OUTPUT_TAIL_BYTES);
  const exitCode = result.timedOut
    ? 124 // matches coreutils `timeout` exit code; the cloud uses this as a sentinel
    : (result.exitCode ?? 1);
  return { exitCode, stdoutTail, stderrTail };
}

// ─── Handler 6: gitDiffSnapshot ────────────────────────────────────────────

/**
 * Snapshot the diff of the worktree's branch vs `main`. Used by the drawer
 * "Review" tab. Truncates very large diffs to `DIFF_MAX_BYTES` with a marker
 * so the UI can show a hint.
 */
export async function gitDiffSnapshot(
  req: GitDiffSnapshotRequest,
): Promise<GitDiffSnapshotResponse> {
  const wt = resolve(req.worktreePath);
  if (!(await pathExists(wt))) {
    throw new GitOpError("worktree-not-found", `worktreePath ${wt} does not exist`);
  }
  // Confirm we're inside a git worktree before issuing diff commands.
  const isRepo = await execa("git", ["-C", wt, "rev-parse", "--git-dir"], { reject: false });
  if (isRepo.exitCode !== 0) {
    throw new GitOpError("not-a-git-repo", `${wt} is not a git worktree`);
  }
  // `main..HEAD` shows commits on the worktree branch that aren't on main —
  // i.e. exactly what the task added.
  const diffRes = await execa("git", ["-C", wt, "diff", "main..HEAD"], { reject: false });
  if (diffRes.exitCode !== 0) {
    throw new GitOpError(
      "diff-failed",
      diffRes.stderr || `git diff exited ${diffRes.exitCode}`,
    );
  }
  let diff = String(diffRes.stdout ?? "");
  if (Buffer.byteLength(diff, "utf8") > DIFF_MAX_BYTES) {
    diff =
      diff.slice(0, DIFF_MAX_BYTES) +
      "\n... (diff truncated; exceeds 200KB host-side cap)\n";
  }
  // `--shortstat` returns a single summary line like " 3 files changed, 12 insertions(+), 4 deletions(-)".
  const statRes = await execa("git", ["-C", wt, "diff", "--shortstat", "main..HEAD"], {
    reject: false,
  });
  const stats = parseShortstat(String(statRes.stdout ?? ""));
  return { diff, stats };
}

/** Parse `git diff --shortstat` output. Returns zeros if the regex misses. */
function parseShortstat(line: string): { files: number; additions: number; deletions: number } {
  // Format: " 3 files changed, 12 insertions(+), 4 deletions(-)"
  // Any of the three may be absent (e.g. "1 file changed, 1 insertion(+)").
  const files = /(\d+)\s+files?\s+changed/.exec(line)?.[1] ?? "0";
  const additions = /(\d+)\s+insertions?\(\+\)/.exec(line)?.[1] ?? "0";
  const deletions = /(\d+)\s+deletions?\(-\)/.exec(line)?.[1] ?? "0";
  return {
    files: Number(files),
    additions: Number(additions),
    deletions: Number(deletions),
  };
}

// Re-exports for tests that want to assert on internal helpers without
// importing private symbols.
export const __internals = { assertWorktreeInRepo, assertIsGitRepo, parseShortstat, pathExists, tailBytes, stat };
