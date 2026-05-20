import { describe, it, expect } from "vitest";
import {
  projectSchema,
  projectTaskSchema,
  taskRunSchema,
  mergePolicySchema,
  taskStateSchema,
  prioritySchema,
  taskExitReasonSchema,
} from "./project.js";
import { clientToCloudSchema, cloudToClientSchema } from "./protocol.js";
import {
  hostRpcRequestSchema,
  hostRpcResponseSchema,
  gitInitIfMissingRequestSchema,
  gitInitIfMissingResponseSchema,
  gitWorktreeCreateRequestSchema,
  gitWorktreeCreateResponseSchema,
  gitWorktreeRemoveRequestSchema,
  gitWorktreeRemoveResponseSchema,
  gitMergeToMainRequestSchema,
  gitMergeToMainResponseSchema,
  gitTestsRunRequestSchema,
  gitTestsRunResponseSchema,
  gitDiffSnapshotRequestSchema,
  gitDiffSnapshotResponseSchema,
  fsBrowseRequestSchema,
  fsBrowseResponseSchema,
} from "./host-protocol.js";

// ─── Sample valid payloads ──────────────────────────────────────────────────

const validProject = {
  id: "p1",
  tenantId: "t1",
  userId: "u1",
  name: "MyApp",
  description: "demo",
  repoPath: "/Users/me/code/myapp",
  defaultHostId: "h1",
  threadId: null,
  mergePolicy: "require-review",
  testCommand: null,
  concurrencyLimit: 2,
  systemPrompt: null,
  pushToRemote: false,
  archivedAt: null,
  createdAt: "2026-05-19T00:00:00Z",
  updatedAt: "2026-05-19T00:00:00Z",
};

const validTask = {
  id: "task1",
  projectId: "p1",
  ref: "MYAPP-1",
  title: "Add todo button",
  description: null,
  state: "queued",
  priority: 3,
  labels: ["frontend"],
  orderIndex: "1",
  hostId: null,
  adapter: null,
  worktreePath: null,
  branchName: null,
  executionThreadId: null,
  retries: 0,
  maxRetries: 3,
  needsInputWhat: null,
  createdAt: "2026-05-19T00:00:00Z",
  updatedAt: "2026-05-19T00:00:00Z",
  startedAt: null,
  completedAt: null,
};

const validRun = {
  id: "run1",
  taskId: "task1",
  runnerSessionId: "rs1",
  attemptNumber: 1,
  startedAt: "2026-05-19T00:00:00Z",
  endedAt: null,
  exitReason: null,
  errorMessage: null,
};

// ─── Enum schemas ────────────────────────────────────────────────────────────

describe("SP-3 enum schemas", () => {
  it("mergePolicySchema accepts the 3 valid values and rejects others", () => {
    expect(mergePolicySchema.safeParse("require-review").success).toBe(true);
    expect(mergePolicySchema.safeParse("auto-merge").success).toBe(true);
    expect(mergePolicySchema.safeParse("auto-merge-if-tests-pass").success).toBe(true);
    expect(mergePolicySchema.safeParse("force-push").success).toBe(false);
  });

  it("taskStateSchema accepts all 7 states", () => {
    for (const s of ["queued", "running", "needs-input", "reviewing", "done", "failed", "cancelled"]) {
      expect(taskStateSchema.safeParse(s).success).toBe(true);
    }
    expect(taskStateSchema.safeParse("paused").success).toBe(false);
  });

  it("prioritySchema accepts 0-4 only", () => {
    for (const p of [0, 1, 2, 3, 4]) {
      expect(prioritySchema.safeParse(p).success).toBe(true);
    }
    expect(prioritySchema.safeParse(5).success).toBe(false);
    expect(prioritySchema.safeParse(-1).success).toBe(false);
  });

  it("taskExitReasonSchema accepts the 6 reasons", () => {
    for (const r of ["done", "failed", "timeout", "host-disconnect", "cancelled", "business-clarification"]) {
      expect(taskExitReasonSchema.safeParse(r).success).toBe(true);
    }
    expect(taskExitReasonSchema.safeParse("explosion").success).toBe(false);
  });
});

// ─── Project / ProjectTask / TaskRun parse round-trips ─────────────────────

describe("Project schema", () => {
  it("parses a valid Project", () => {
    expect(projectSchema.safeParse(validProject).success).toBe(true);
  });
  it("rejects a Project with bad mergePolicy", () => {
    expect(projectSchema.safeParse({ ...validProject, mergePolicy: "yolo" }).success).toBe(false);
  });
  it("rejects a Project with concurrencyLimit out of bounds", () => {
    expect(projectSchema.safeParse({ ...validProject, concurrencyLimit: 0 }).success).toBe(false);
    expect(projectSchema.safeParse({ ...validProject, concurrencyLimit: 17 }).success).toBe(false);
  });
});

describe("ProjectTask schema", () => {
  it("parses a valid ProjectTask", () => {
    expect(projectTaskSchema.safeParse(validTask).success).toBe(true);
  });
  it("rejects a ProjectTask with unknown state", () => {
    expect(projectTaskSchema.safeParse({ ...validTask, state: "paused" }).success).toBe(false);
  });
  it("rejects a ProjectTask with non-integer priority", () => {
    expect(projectTaskSchema.safeParse({ ...validTask, priority: 1.5 }).success).toBe(false);
  });
});

describe("TaskRun schema", () => {
  it("parses a valid TaskRun", () => {
    expect(taskRunSchema.safeParse(validRun).success).toBe(true);
  });
  it("parses an ended TaskRun with exitReason+errorMessage", () => {
    expect(
      taskRunSchema.safeParse({
        ...validRun,
        endedAt: "2026-05-19T00:01:00Z",
        exitReason: "failed",
        errorMessage: "test boom",
      }).success,
    ).toBe(true);
  });
  it("rejects TaskRun with attemptNumber=0", () => {
    expect(taskRunSchema.safeParse({ ...validRun, attemptNumber: 0 }).success).toBe(false);
  });
});

// ─── Protocol SP-3 messages ─────────────────────────────────────────────────

describe("SP-3 ClientToCloud messages", () => {
  it("parses subscribe-projects", () => {
    expect(clientToCloudSchema.safeParse({ t: "subscribe-projects" }).success).toBe(true);
  });
  it("parses unsubscribe-projects", () => {
    expect(clientToCloudSchema.safeParse({ t: "unsubscribe-projects" }).success).toBe(true);
  });
  it("parses subscribe-project with projectId", () => {
    expect(clientToCloudSchema.safeParse({ t: "subscribe-project", projectId: "p1" }).success).toBe(true);
  });
  it("parses unsubscribe-project with projectId", () => {
    expect(clientToCloudSchema.safeParse({ t: "unsubscribe-project", projectId: "p1" }).success).toBe(true);
  });
  it("parses subscribe-task with taskId", () => {
    expect(clientToCloudSchema.safeParse({ t: "subscribe-task", taskId: "task1" }).success).toBe(true);
  });
  it("parses unsubscribe-task with taskId", () => {
    expect(clientToCloudSchema.safeParse({ t: "unsubscribe-task", taskId: "task1" }).success).toBe(true);
  });
  it("rejects subscribe-project without projectId", () => {
    expect(clientToCloudSchema.safeParse({ t: "subscribe-project" }).success).toBe(false);
  });
  it("round-trips subscribe-projects through parse twice", () => {
    const parsed1 = clientToCloudSchema.parse({ t: "subscribe-projects" });
    const parsed2 = clientToCloudSchema.parse(parsed1);
    expect(parsed1).toEqual(parsed2);
  });
});

describe("SP-3 CloudToClient messages", () => {
  it("parses a project-event 'created'", () => {
    const r = cloudToClientSchema.safeParse({
      t: "project-event",
      kind: "created",
      project: validProject,
    });
    expect(r.success).toBe(true);
  });

  it("parses a project-event 'archived'", () => {
    const r = cloudToClientSchema.safeParse({
      t: "project-event",
      kind: "archived",
      project: { ...validProject, archivedAt: "2026-05-19T01:00:00Z" },
    });
    expect(r.success).toBe(true);
  });

  it("parses a task-event 'state-changed'", () => {
    const r = cloudToClientSchema.safeParse({
      t: "task-event",
      kind: "state-changed",
      task: { ...validTask, state: "running" },
    });
    expect(r.success).toBe(true);
  });

  it("parses a task-event 'deleted'", () => {
    const r = cloudToClientSchema.safeParse({
      t: "task-event",
      kind: "deleted",
      task: validTask,
    });
    expect(r.success).toBe(true);
  });

  it("rejects a task-event with unknown kind", () => {
    expect(
      cloudToClientSchema.safeParse({
        t: "task-event",
        kind: "exploded",
        task: validTask,
      }).success,
    ).toBe(false);
  });

  it("round-trips a task-event payload", () => {
    const frame = { t: "task-event" as const, kind: "updated" as const, task: validTask };
    const a = cloudToClientSchema.parse(frame);
    const b = cloudToClientSchema.parse(a);
    expect(a).toEqual(b);
  });
});

// ─── Host RPC: per-method req/resp parsing ─────────────────────────────────

describe("HostRpc per-method req/resp schemas", () => {
  it("parses git-init-if-missing req+resp", () => {
    expect(gitInitIfMissingRequestSchema.safeParse({ repoPath: "/r" }).success).toBe(true);
    expect(gitInitIfMissingRequestSchema.safeParse({ repoPath: "/r", initialReadme: "# r" }).success).toBe(true);
    expect(gitInitIfMissingResponseSchema.safeParse({ initialized: false }).success).toBe(true);
  });

  it("parses git-worktree-create req+resp", () => {
    expect(
      gitWorktreeCreateRequestSchema.safeParse({
        repoPath: "/r",
        branchName: "task/myapp-1",
        worktreePath: "/r/.worktrees/myapp-1",
      }).success,
    ).toBe(true);
    expect(gitWorktreeCreateResponseSchema.safeParse({ worktreePath: "/r/.worktrees/myapp-1" }).success).toBe(true);
  });

  it("parses git-worktree-remove req+resp (force=true|false)", () => {
    expect(gitWorktreeRemoveRequestSchema.safeParse({ worktreePath: "/r/.worktrees/x", force: true }).success).toBe(true);
    expect(gitWorktreeRemoveRequestSchema.safeParse({ worktreePath: "/r/.worktrees/x", force: false }).success).toBe(true);
    expect(gitWorktreeRemoveResponseSchema.safeParse({ removed: true }).success).toBe(true);
  });

  it("parses git-merge-to-main req+resp (with and without message)", () => {
    expect(
      gitMergeToMainRequestSchema.safeParse({ repoPath: "/r", branchName: "task/myapp-1" }).success,
    ).toBe(true);
    expect(
      gitMergeToMainRequestSchema.safeParse({
        repoPath: "/r",
        branchName: "task/myapp-1",
        commitMessage: "merge MYAPP-1",
      }).success,
    ).toBe(true);
    expect(gitMergeToMainResponseSchema.safeParse({ ok: true }).success).toBe(true);
    expect(gitMergeToMainResponseSchema.safeParse({ ok: false, message: "conflict" }).success).toBe(true);
  });

  it("parses git-tests-run req+resp", () => {
    expect(
      gitTestsRunRequestSchema.safeParse({ worktreePath: "/r/.wt/x", command: "pnpm test", timeoutMs: 60000 }).success,
    ).toBe(true);
    expect(
      gitTestsRunResponseSchema.safeParse({ exitCode: 0, stdoutTail: "ok", stderrTail: "" }).success,
    ).toBe(true);
    expect(
      gitTestsRunRequestSchema.safeParse({ worktreePath: "/r/.wt/x", command: "x", timeoutMs: 0 }).success,
    ).toBe(false);
  });

  it("parses git-diff-snapshot req+resp", () => {
    expect(gitDiffSnapshotRequestSchema.safeParse({ worktreePath: "/r/.wt/x" }).success).toBe(true);
    expect(
      gitDiffSnapshotResponseSchema.safeParse({
        diff: "diff --git a/x b/x",
        stats: { files: 1, additions: 3, deletions: 1 },
      }).success,
    ).toBe(true);
  });

  it("parses fs-browse req+resp (with and without path)", () => {
    expect(fsBrowseRequestSchema.safeParse({}).success).toBe(true);
    expect(fsBrowseRequestSchema.safeParse({ path: "/Users" }).success).toBe(true);
    expect(
      fsBrowseResponseSchema.safeParse({
        cwd: "/Users",
        entries: [
          { name: "me", type: "dir" },
          { name: ".bashrc", type: "file", size: 1234 },
        ],
      }).success,
    ).toBe(true);
    expect(
      fsBrowseResponseSchema.safeParse({
        cwd: "/Users",
        entries: [{ name: "x", type: "socket" }],
      }).success,
    ).toBe(false);
  });
});

// ─── Host RPC: discriminated-union dispatch ─────────────────────────────────

describe("HostRpc envelope dispatch", () => {
  it("hostRpcRequestSchema discriminates on method", () => {
    expect(
      hostRpcRequestSchema.safeParse({
        method: "git-worktree-create",
        params: { repoPath: "/r", branchName: "task/x", worktreePath: "/r/.wt/x" },
      }).success,
    ).toBe(true);
    expect(
      hostRpcRequestSchema.safeParse({
        method: "fs-browse",
        params: { path: "/Users/me" },
      }).success,
    ).toBe(true);
  });

  it("hostRpcRequestSchema rejects wrong params shape for chosen method", () => {
    // fs-browse params do not contain `repoPath`; supplying git-init-if-missing's
    // shape under method=fs-browse must fail strict validation.
    expect(
      hostRpcRequestSchema.safeParse({
        method: "git-worktree-create",
        params: { path: "/r" }, // wrong shape for git-worktree-create
      }).success,
    ).toBe(false);
  });

  it("hostRpcResponseSchema parses an ok=true success", () => {
    expect(
      hostRpcResponseSchema.safeParse({
        method: "git-worktree-remove",
        ok: true,
        result: { removed: true },
      }).success,
    ).toBe(true);
  });

  it("hostRpcResponseSchema parses an ok=false error frame", () => {
    expect(
      hostRpcResponseSchema.safeParse({
        method: "git-merge-to-main",
        ok: false,
        error: { code: "conflict", message: "merge conflict in src/foo.ts" },
      }).success,
    ).toBe(true);
  });

  it("hostRpcResponseSchema rejects unknown method", () => {
    expect(
      hostRpcResponseSchema.safeParse({
        method: "git-rebase",
        ok: false,
        error: { code: "x", message: "y" },
      }).success,
    ).toBe(false);
  });
});
