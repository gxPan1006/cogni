import { describe, it, expect, vi } from "vitest";
import type { Project, ProjectTask, HostRpcRequest, HostRpcResponse } from "@cogni/contract";
import { HostRpcClient } from "./host-rpc.js";
import { evaluateAndApplyMergeGate } from "./merge-gate.js";

// Minimal stable fixtures — gate is pure of DB.
function fakeProject(over: Partial<Project> = {}): Project {
  return {
    id: "p1", tenantId: "t1", userId: "u1", name: "P",
    description: null, repoPath: "/r", defaultHostId: "h1",
    threadId: null,
    mergePolicy: "require-review",
    testCommand: null, concurrencyLimit: 2, systemPrompt: null,
    pushToRemote: false,
    archivedAt: null,
    createdAt: "2026-05-19T00:00:00.000Z",
    updatedAt: "2026-05-19T00:00:00.000Z",
    ...over,
  };
}

function fakeTask(over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "task1", projectId: "p1", ref: "T-1", title: "x", description: null,
    state: "running", priority: 0, labels: [], orderIndex: "1",
    hostId: "h1", adapter: null,
    worktreePath: "/r.worktrees/T-1", branchName: "task/t-1",
    executionThreadId: "th1",
    retries: 0, maxRetries: 3, needsInputWhat: null,
    createdAt: "2026-05-19T00:00:00.000Z",
    updatedAt: "2026-05-19T00:00:00.000Z",
    startedAt: "2026-05-19T00:00:00.000Z",
    completedAt: null,
    ...over,
  };
}

function mkRpc(handler: (req: HostRpcRequest) => Promise<HostRpcResponse>) {
  const send = vi.fn(async (_h: string, req: HostRpcRequest) => handler(req));
  return { rpc: new HostRpcClient({ sendHostRpc: send }), send };
}

describe("merge-gate: require-review policy", () => {
  it("returns reviewing without any host RPC", async () => {
    const { rpc, send } = mkRpc(async () => {
      throw new Error("should not call host");
    });
    const out = await evaluateAndApplyMergeGate(
      { hostRpc: rpc },
      fakeProject({ mergePolicy: "require-review" }),
      fakeTask(),
    );
    expect(out).toBe("reviewing");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("merge-gate: auto-merge policy", () => {
  it("returns done on successful merge + cleans worktree", async () => {
    const calls: HostRpcRequest["method"][] = [];
    const { rpc } = mkRpc(async (req) => {
      calls.push(req.method);
      if (req.method === "git-merge-to-main") {
        return { ok: true, method: "git-merge-to-main", result: { ok: true } };
      }
      if (req.method === "git-worktree-remove") {
        return { ok: true, method: "git-worktree-remove", result: { removed: true } };
      }
      throw new Error(`unexpected ${req.method}`);
    });
    const out = await evaluateAndApplyMergeGate(
      { hostRpc: rpc },
      fakeProject({ mergePolicy: "auto-merge" }),
      fakeTask(),
    );
    expect(out).toBe("done");
    expect(calls).toEqual(["git-merge-to-main", "git-worktree-remove"]);
  });

  it("pushToRemote=true: pushes main between merge and worktree-remove", async () => {
    const calls: HostRpcRequest["method"][] = [];
    const { rpc } = mkRpc(async (req) => {
      calls.push(req.method);
      if (req.method === "git-merge-to-main") return { ok: true, method: req.method, result: { ok: true } };
      if (req.method === "git-push-to-remote") return { ok: true, method: req.method, result: { ok: true } };
      if (req.method === "git-worktree-remove") return { ok: true, method: req.method, result: { removed: true } };
      throw new Error(`unexpected ${req.method}`);
    });
    const out = await evaluateAndApplyMergeGate(
      { hostRpc: rpc },
      fakeProject({ mergePolicy: "auto-merge", pushToRemote: true }),
      fakeTask(),
    );
    expect(out).toBe("done");
    expect(calls).toEqual(["git-merge-to-main", "git-push-to-remote", "git-worktree-remove"]);
  });

  it("pushToRemote=true but push fails: still done (best-effort), worktree still cleaned", async () => {
    const calls: HostRpcRequest["method"][] = [];
    const { rpc } = mkRpc(async (req) => {
      calls.push(req.method);
      if (req.method === "git-merge-to-main") return { ok: true, method: req.method, result: { ok: true } };
      if (req.method === "git-push-to-remote") return { ok: true, method: req.method, result: { ok: false, message: "no 'origin' remote configured" } };
      if (req.method === "git-worktree-remove") return { ok: true, method: req.method, result: { removed: true } };
      throw new Error(`unexpected ${req.method}`);
    });
    const out = await evaluateAndApplyMergeGate(
      { hostRpc: rpc },
      fakeProject({ mergePolicy: "auto-merge", pushToRemote: true }),
      fakeTask(),
    );
    expect(out).toBe("done"); // push failure is non-fatal
    expect(calls).toEqual(["git-merge-to-main", "git-push-to-remote", "git-worktree-remove"]);
  });

  it("returns reviewing when merge returns ok=false (conflict)", async () => {
    const { rpc } = mkRpc(async (req) => {
      if (req.method === "git-merge-to-main") {
        return {
          ok: true, method: "git-merge-to-main",
          result: { ok: false, message: "Auto-merging foo.ts CONFLICT" },
        };
      }
      throw new Error(`unexpected ${req.method}`);
    });
    const out = await evaluateAndApplyMergeGate(
      { hostRpc: rpc },
      fakeProject({ mergePolicy: "auto-merge" }),
      fakeTask(),
    );
    expect(out).toBe("reviewing");
  });

  it("returns reviewing when merge RPC throws (host error)", async () => {
    const { rpc } = mkRpc(async () => ({
      ok: false, method: "git-merge-to-main",
      error: { code: "git-error", message: "fatal" },
    }));
    const out = await evaluateAndApplyMergeGate(
      { hostRpc: rpc },
      fakeProject({ mergePolicy: "auto-merge" }),
      fakeTask(),
    );
    expect(out).toBe("reviewing");
  });

  it("returns reviewing (with warn) when task is missing host/worktree/branch", async () => {
    const { rpc, send } = mkRpc(async () => {
      throw new Error("should not call host");
    });
    const out = await evaluateAndApplyMergeGate(
      { hostRpc: rpc },
      fakeProject({ mergePolicy: "auto-merge" }),
      fakeTask({ hostId: null, worktreePath: null, branchName: null }),
    );
    expect(out).toBe("reviewing");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("merge-gate: auto-merge-if-tests-pass policy", () => {
  it("runs tests; on exit=0 proceeds with auto-merge → done", async () => {
    const calls: HostRpcRequest["method"][] = [];
    const { rpc } = mkRpc(async (req) => {
      calls.push(req.method);
      if (req.method === "git-tests-run") {
        return { ok: true, method: "git-tests-run", result: { exitCode: 0, stdoutTail: "", stderrTail: "" } };
      }
      if (req.method === "git-merge-to-main") {
        return { ok: true, method: "git-merge-to-main", result: { ok: true } };
      }
      if (req.method === "git-worktree-remove") {
        return { ok: true, method: "git-worktree-remove", result: { removed: true } };
      }
      throw new Error(`unexpected ${req.method}`);
    });
    const out = await evaluateAndApplyMergeGate(
      { hostRpc: rpc },
      fakeProject({ mergePolicy: "auto-merge-if-tests-pass", testCommand: "pnpm test" }),
      fakeTask(),
    );
    expect(out).toBe("done");
    expect(calls).toEqual(["git-tests-run", "git-merge-to-main", "git-worktree-remove"]);
  });

  it("on exit≠0 stays in reviewing; no merge attempted", async () => {
    const calls: HostRpcRequest["method"][] = [];
    const { rpc } = mkRpc(async (req) => {
      calls.push(req.method);
      if (req.method === "git-tests-run") {
        return { ok: true, method: "git-tests-run", result: { exitCode: 1, stdoutTail: "", stderrTail: "FAIL" } };
      }
      throw new Error(`unexpected ${req.method}`);
    });
    const out = await evaluateAndApplyMergeGate(
      { hostRpc: rpc },
      fakeProject({ mergePolicy: "auto-merge-if-tests-pass", testCommand: "pnpm test" }),
      fakeTask(),
    );
    expect(out).toBe("reviewing");
    expect(calls).toEqual(["git-tests-run"]);
  });

  it("on missing testCommand stays in reviewing without running anything", async () => {
    const { rpc, send } = mkRpc(async () => {
      throw new Error("should not call host");
    });
    const out = await evaluateAndApplyMergeGate(
      { hostRpc: rpc },
      fakeProject({ mergePolicy: "auto-merge-if-tests-pass", testCommand: null }),
      fakeTask(),
    );
    expect(out).toBe("reviewing");
    expect(send).not.toHaveBeenCalled();
  });

  it("if worktree-remove fails post-merge, still returns done (non-fatal cleanup)", async () => {
    const { rpc } = mkRpc(async (req) => {
      if (req.method === "git-merge-to-main") {
        return { ok: true, method: "git-merge-to-main", result: { ok: true } };
      }
      if (req.method === "git-worktree-remove") {
        return { ok: false, method: "git-worktree-remove", error: { code: "git-error", message: "stuck" } };
      }
      throw new Error(`unexpected ${req.method}`);
    });
    const out = await evaluateAndApplyMergeGate(
      { hostRpc: rpc },
      fakeProject({ mergePolicy: "auto-merge" }),
      fakeTask(),
    );
    expect(out).toBe("done");
  });
});
