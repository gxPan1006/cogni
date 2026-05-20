/**
 * Integration tests for git-ops.ts. Each test scaffolds a fresh repo + worktree
 * in `os.tmpdir()` so they're parallel-safe and self-cleaning. We invoke the
 * real `git` CLI — the handlers are thin wrappers around `git`, and mocking
 * subprocess output would lose the safety-invariant guarantees we care about.
 *
 * The whole suite skips when `git` isn't on PATH (CI containers always have
 * it; some sandboxed dev environments don't).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import {
  gitInitIfMissing,
  gitWorktreeCreate,
  gitWorktreeRemove,
  gitMergeToMain,
  gitPushToRemote,
  gitTestsRun,
  gitDiffSnapshot,
  GitOpError,
} from "./git-ops.js";

// Detect git synchronously at module load — `it.skipIf(...)` is evaluated
// when the test function is registered (before `beforeAll` runs), so an
// async check would always read its initial value (`false`) and skip
// everything. CI containers always have git; this falls back gracefully
// on locked-down sandboxes.
let hasGit = false;
try {
  execSync("git --version", { stdio: "ignore" });
  hasGit = true;
} catch {
  hasGit = false;
}

let tmp = "";
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "cogni-gitops-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function bootstrapRepo(): Promise<string> {
  const repo = join(tmp, "repo");
  await mkdir(repo);
  await gitInitIfMissing({ repoPath: repo });
  return repo;
}

describe("gitInitIfMissing", () => {
  it.skipIf(!hasGit)("initializes a fresh directory with a main branch + initial commit", async () => {
    const repo = join(tmp, "fresh");
    await mkdir(repo);
    const res = await gitInitIfMissing({ repoPath: repo });
    expect(res.initialized).toBe(true);
    // HEAD should resolve — branch + commit both present.
    const head = await execa("git", ["-C", repo, "rev-parse", "HEAD"], { reject: false });
    expect(head.exitCode).toBe(0);
    const branch = await execa("git", ["-C", repo, "branch", "--show-current"], { reject: false });
    expect(branch.stdout.trim()).toBe("main");
  });

  it.skipIf(!hasGit)("is a no-op when the repo already exists", async () => {
    const repo = await bootstrapRepo();
    const res = await gitInitIfMissing({ repoPath: repo });
    expect(res.initialized).toBe(false);
  });

  it.skipIf(!hasGit)("creates missing parent directories", async () => {
    const nested = join(tmp, "a", "b", "c");
    const res = await gitInitIfMissing({ repoPath: nested });
    expect(res.initialized).toBe(true);
    // .git exists ⇒ parents were created
    const { pathExists } = (await import("./git-ops.js")).__internals;
    expect(await pathExists(join(nested, ".git"))).toBe(true);
  });
});

describe("gitWorktreeCreate", () => {
  it.skipIf(!hasGit)("creates a worktree + branch under the repo", async () => {
    const repo = await bootstrapRepo();
    const wt = join(repo, ".worktrees", "task-1");
    const res = await gitWorktreeCreate({
      repoPath: repo,
      branchName: "task/task-1",
      worktreePath: wt,
    });
    expect(res.worktreePath).toBe(resolve(wt));
    const branch = await execa("git", ["-C", wt, "branch", "--show-current"], { reject: false });
    expect(branch.stdout.trim()).toBe("task/task-1");
  });

  it.skipIf(!hasGit)("rejects worktreePath outside the repo (safety invariant 1)", async () => {
    const repo = await bootstrapRepo();
    const wt = join(tmp, "outside-worktree"); // sibling of repo, NOT under it
    await expect(
      gitWorktreeCreate({ repoPath: repo, branchName: "task/x", worktreePath: wt }),
    ).rejects.toMatchObject({ code: "worktree-outside-repo" });
  });

  it.skipIf(!hasGit)("rejects when repoPath is not a git repo (safety invariant 2)", async () => {
    const notRepo = join(tmp, "not-a-repo");
    await mkdir(notRepo);
    await expect(
      gitWorktreeCreate({
        repoPath: notRepo,
        branchName: "task/x",
        worktreePath: join(notRepo, ".wt"),
      }),
    ).rejects.toBeInstanceOf(GitOpError);
  });

  it.skipIf(!hasGit)("rejects a sibling-path attack (repoPath=/r, worktreePath=/r-evil)", async () => {
    const repo = await bootstrapRepo();
    // Paths like `/r-evil/...` share the prefix `/r` but are NOT under `/r`.
    // The handler uses a `sep`-aware comparison so this must be rejected.
    const siblingAttack = `${repo}-evil/wt`;
    await expect(
      gitWorktreeCreate({
        repoPath: repo,
        branchName: "task/x",
        worktreePath: siblingAttack,
      }),
    ).rejects.toMatchObject({ code: "worktree-outside-repo" });
  });
});

describe("gitWorktreeRemove", () => {
  it.skipIf(!hasGit)("removes an existing worktree", async () => {
    const repo = await bootstrapRepo();
    const wt = join(repo, ".worktrees", "task-2");
    await gitWorktreeCreate({ repoPath: repo, branchName: "task/task-2", worktreePath: wt });
    const res = await gitWorktreeRemove({ worktreePath: wt, force: false });
    expect(res.removed).toBe(true);
  });

  it.skipIf(!hasGit)("is idempotent — returns removed=false for a missing path", async () => {
    const res = await gitWorktreeRemove({
      worktreePath: join(tmp, "does-not-exist"),
      force: false,
    });
    expect(res.removed).toBe(false);
  });

  it.skipIf(!hasGit)("force=true removes a dirty worktree where plain remove would refuse", async () => {
    const repo = await bootstrapRepo();
    const wt = join(repo, ".worktrees", "dirty");
    await gitWorktreeCreate({ repoPath: repo, branchName: "task/dirty", worktreePath: wt });
    // Dirty the worktree so `worktree remove` (without --force) would refuse.
    await writeFile(join(wt, "uncommitted.txt"), "wip", "utf8");
    const res = await gitWorktreeRemove({ worktreePath: wt, force: true });
    expect(res.removed).toBe(true);
  });

  it.skipIf(!hasGit)("deletes the task branch when repoPath + branchName given (force=true → -D, unmerged ok)", async () => {
    const repo = await bootstrapRepo();
    const wt = join(repo, ".worktrees", "with-branch");
    await gitWorktreeCreate({ repoPath: repo, branchName: "task/with-branch", worktreePath: wt });
    // Commit something on the branch so it's a real (unmerged) branch.
    await writeFile(join(wt, "f.txt"), "x", "utf8");
    await execa("git", ["-C", wt, "add", "."], { reject: true });
    await execa("git", ["-C", wt, "commit", "-m", "wip"], { reject: true, env: cogniEnv() });

    const res = await gitWorktreeRemove({
      worktreePath: wt,
      force: true, // reject/cancel semantics → -D, discards unmerged branch
      repoPath: repo,
      branchName: "task/with-branch",
    });
    expect(res.removed).toBe(true);
    // Branch should be gone.
    const branches = await execa("git", ["-C", repo, "branch", "--list", "task/with-branch"], { reject: false });
    expect(branches.stdout.trim()).toBe("");
  });

  it.skipIf(!hasGit)("deletes the merged task branch after merge (force=false → -d succeeds)", async () => {
    const repo = await bootstrapRepo();
    const wt = join(repo, ".worktrees", "merged");
    await gitWorktreeCreate({ repoPath: repo, branchName: "task/merged", worktreePath: wt });
    await writeFile(join(wt, "g.txt"), "y", "utf8");
    await execa("git", ["-C", wt, "add", "."], { reject: true });
    await execa("git", ["-C", wt, "commit", "-m", "done"], { reject: true, env: cogniEnv() });
    // Merge into main first (mirrors the real accept flow: merge, THEN remove).
    const merge = await gitMergeToMain({ repoPath: repo, branchName: "task/merged" });
    expect(merge.ok).toBe(true);
    // Branch is still present right after merge (we no longer delete it in merge).
    const before = await execa("git", ["-C", repo, "branch", "--list", "task/merged"], { reject: false });
    expect(before.stdout.trim()).not.toBe("");
    // Now remove worktree + delete branch (-d, merged so it succeeds).
    const res = await gitWorktreeRemove({
      worktreePath: wt,
      force: false,
      repoPath: repo,
      branchName: "task/merged",
    });
    expect(res.removed).toBe(true);
    const after = await execa("git", ["-C", repo, "branch", "--list", "task/merged"], { reject: false });
    expect(after.stdout.trim()).toBe("");
  });
});

describe("gitMergeToMain", () => {
  it.skipIf(!hasGit)("merges a clean branch into main", async () => {
    const repo = await bootstrapRepo();
    const wt = join(repo, ".worktrees", "feature");
    await gitWorktreeCreate({ repoPath: repo, branchName: "task/feature", worktreePath: wt });
    await writeFile(join(wt, "file.txt"), "hello", "utf8");
    await execa("git", ["-C", wt, "add", "."], { reject: true });
    await execa("git", ["-C", wt, "commit", "-m", "feature work"], {
      reject: true,
      env: cogniEnv(),
    });
    const res = await gitMergeToMain({ repoPath: repo, branchName: "task/feature" });
    expect(res.ok).toBe(true);
    const log = await execa("git", ["-C", repo, "log", "--oneline"], { reject: false });
    expect(log.stdout).toMatch(/Merge branch/);
  });

  it.skipIf(!hasGit)("returns ok=false with a message on conflict", async () => {
    const repo = await bootstrapRepo();
    // Commit a file on main first.
    await writeFile(join(repo, "conflict.txt"), "main version", "utf8");
    await execa("git", ["-C", repo, "add", "."], { reject: true });
    await execa("git", ["-C", repo, "commit", "-m", "main change"], {
      reject: true,
      env: cogniEnv(),
    });
    // Now branch off an *earlier* state via a worktree from HEAD~1 — easier:
    // make a sibling branch with a conflicting change.
    await execa("git", ["-C", repo, "checkout", "-b", "task/conflict", "HEAD~1"], {
      reject: true,
    });
    await writeFile(join(repo, "conflict.txt"), "task version", "utf8");
    await execa("git", ["-C", repo, "add", "."], { reject: true });
    await execa("git", ["-C", repo, "commit", "-m", "task change"], {
      reject: true,
      env: cogniEnv(),
    });
    await execa("git", ["-C", repo, "checkout", "main"], { reject: true });
    const res = await gitMergeToMain({ repoPath: repo, branchName: "task/conflict" });
    expect(res.ok).toBe(false);
    expect(res.message).toBeTruthy();
  });
});

describe("gitPushToRemote", () => {
  it.skipIf(!hasGit)("pushes main to a configured remote", async () => {
    const repo = await bootstrapRepo();
    // Bare repo to act as the remote.
    const remote = join(tmp, "remote.git");
    await execa("git", ["init", "--bare", remote], { reject: true });
    await execa("git", ["-C", repo, "remote", "add", "origin", remote], { reject: true });

    const res = await gitPushToRemote({ repoPath: repo, branch: "main" });
    expect(res.ok).toBe(true);
    // The bare remote should now have the main branch at the same commit.
    const remoteHead = await execa("git", ["-C", remote, "rev-parse", "main"], { reject: false });
    const localHead = await execa("git", ["-C", repo, "rev-parse", "main"], { reject: false });
    expect(remoteHead.stdout.trim()).toBe(localHead.stdout.trim());
  });

  it.skipIf(!hasGit)("returns ok=false (not throw) when no remote is configured", async () => {
    const repo = await bootstrapRepo();
    const res = await gitPushToRemote({ repoPath: repo, branch: "main" });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/no 'origin' remote/);
  });
});

describe("gitTestsRun", () => {
  it.skipIf(!hasGit)("captures stdout/stderr tails + exit code", async () => {
    const repo = await bootstrapRepo();
    const wt = join(repo, ".worktrees", "tests");
    await gitWorktreeCreate({ repoPath: repo, branchName: "task/tests", worktreePath: wt });
    const res = await gitTestsRun({
      worktreePath: wt,
      command: "echo hello-stdout && echo hello-stderr 1>&2 && exit 7",
      timeoutMs: 5000,
    });
    expect(res.exitCode).toBe(7);
    expect(res.stdoutTail).toContain("hello-stdout");
    expect(res.stderrTail).toContain("hello-stderr");
  });

  it.skipIf(!hasGit)("times out and reports exitCode=124", async () => {
    const repo = await bootstrapRepo();
    const wt = join(repo, ".worktrees", "timeout");
    await gitWorktreeCreate({ repoPath: repo, branchName: "task/timeout", worktreePath: wt });
    const res = await gitTestsRun({
      worktreePath: wt,
      command: "sleep 10",
      timeoutMs: 200,
    });
    expect(res.exitCode).toBe(124);
  });
});

describe("gitDiffSnapshot", () => {
  it.skipIf(!hasGit)("returns diff + stats for a branch ahead of main", async () => {
    const repo = await bootstrapRepo();
    const wt = join(repo, ".worktrees", "diff");
    await gitWorktreeCreate({ repoPath: repo, branchName: "task/diff", worktreePath: wt });
    await writeFile(join(wt, "new.txt"), "alpha\nbeta\ngamma\n", "utf8");
    await execa("git", ["-C", wt, "add", "."], { reject: true });
    await execa("git", ["-C", wt, "commit", "-m", "add new.txt"], {
      reject: true,
      env: cogniEnv(),
    });
    const res = await gitDiffSnapshot({ worktreePath: wt });
    expect(res.diff).toContain("new.txt");
    expect(res.diff).toContain("+alpha");
    expect(res.stats.files).toBeGreaterThanOrEqual(1);
    expect(res.stats.additions).toBeGreaterThanOrEqual(3);
  });

  it.skipIf(!hasGit)("throws when worktreePath does not exist", async () => {
    await expect(
      gitDiffSnapshot({ worktreePath: join(tmp, "ghost") }),
    ).rejects.toMatchObject({ code: "worktree-not-found" });
  });
});

// ─── Module-level utilities (avoid leaking git env into the test process) ──

function cogniEnv() {
  return {
    GIT_AUTHOR_NAME: "cogni",
    GIT_AUTHOR_EMAIL: "cogni@localhost",
    GIT_COMMITTER_NAME: "cogni",
    GIT_COMMITTER_EMAIL: "cogni@localhost",
  };
}

// Touch unused imports so an over-eager linter doesn't prune them.
void readFile;
