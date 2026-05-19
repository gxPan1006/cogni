import { describe, it, expect, vi } from "vitest";
import type { HostRpcRequest, HostRpcResponse } from "@cogni/contract";
import { HostRpcClient, HostRpcError, type SendHostRpcFn } from "./host-rpc.js";

function mkClient(handler: (hostId: string, req: HostRpcRequest) => Promise<HostRpcResponse>) {
  const send: SendHostRpcFn = vi.fn(handler);
  return { client: new HostRpcClient({ sendHostRpc: send }), send };
}

describe("HostRpcClient happy paths", () => {
  it("gitInitIfMissing returns the typed result on ok=true", async () => {
    const { client, send } = mkClient(async (_h, req) => {
      expect(req.method).toBe("git-init-if-missing");
      return { ok: true, method: "git-init-if-missing", result: { initialized: true } };
    });
    const out = await client.gitInitIfMissing("h1", { repoPath: "/r" });
    expect(out).toEqual({ initialized: true });
    expect(send).toHaveBeenCalledOnce();
  });

  it("gitWorktreeCreate echoes worktreePath", async () => {
    const { client } = mkClient(async () => ({
      ok: true, method: "git-worktree-create",
      result: { worktreePath: "/r.worktrees/T-1" },
    }));
    const out = await client.gitWorktreeCreate("h1", {
      repoPath: "/r", branchName: "task/t-1", worktreePath: "/r.worktrees/T-1",
    });
    expect(out.worktreePath).toBe("/r.worktrees/T-1");
  });

  it("gitTestsRun returns exitCode + tails", async () => {
    const { client } = mkClient(async () => ({
      ok: true, method: "git-tests-run",
      result: { exitCode: 0, stdoutTail: "ok", stderrTail: "" },
    }));
    const out = await client.gitTestsRun("h1", { worktreePath: "/w", command: "pnpm test", timeoutMs: 1000 });
    expect(out.exitCode).toBe(0);
  });

  it("gitDiffSnapshot returns diff + stats", async () => {
    const { client } = mkClient(async () => ({
      ok: true, method: "git-diff-snapshot",
      result: { diff: "...", stats: { files: 1, additions: 5, deletions: 2 } },
    }));
    const out = await client.gitDiffSnapshot("h1", { worktreePath: "/w" });
    expect(out.stats.files).toBe(1);
  });

  it("fsBrowse returns entries + cwd", async () => {
    const { client } = mkClient(async () => ({
      ok: true, method: "fs-browse",
      result: { entries: [{ name: "src", type: "dir" }], cwd: "/home" },
    }));
    const out = await client.fsBrowse("h1", { path: "/home" });
    expect(out.cwd).toBe("/home");
    expect(out.entries[0]?.name).toBe("src");
  });
});

describe("HostRpcClient error paths", () => {
  it("throws HostRpcError on ok=false", async () => {
    const { client } = mkClient(async () => ({
      ok: false, method: "git-merge-to-main",
      error: { code: "merge-conflict", message: "Auto-merging foo.ts CONFLICT" },
    }));
    await expect(
      client.gitMergeToMain("h1", { repoPath: "/r", branchName: "task/t-1" }),
    ).rejects.toMatchObject({
      name: "HostRpcError",
      method: "git-merge-to-main",
      code: "merge-conflict",
    });
  });

  it("throws HostRpcError(code='host-offline') when transport rejects", async () => {
    const { client } = mkClient(async () => {
      throw { code: "host-offline", message: "host h1 offline" };
    });
    await expect(
      client.gitInitIfMissing("h1", { repoPath: "/r" }),
    ).rejects.toMatchObject({
      name: "HostRpcError",
      code: "host-offline",
    });
  });

  it("throws HostRpcError on method-mismatch (host echoed wrong success variant)", async () => {
    const { client } = mkClient(async () => ({
      ok: true, method: "git-worktree-create",
      result: { worktreePath: "/x" },
    }));
    await expect(
      // We asked for git-init-if-missing but the mock echoes a different method.
      client.gitInitIfMissing("h1", { repoPath: "/r" }),
    ).rejects.toMatchObject({
      name: "HostRpcError",
      code: "method-mismatch",
    });
  });

  it("HostRpcError carries method + code + readable message", async () => {
    const { client } = mkClient(async () => ({
      ok: false, method: "git-tests-run",
      error: { code: "timeout", message: "exceeded 1000ms" },
    }));
    try {
      await client.gitTestsRun("h1", { worktreePath: "/w", command: "x", timeoutMs: 1000 });
      throw new Error("should not reach");
    } catch (e) {
      expect(e).toBeInstanceOf(HostRpcError);
      const err = e as HostRpcError;
      expect(err.method).toBe("git-tests-run");
      expect(err.code).toBe("timeout");
      expect(err.message).toContain("git-tests-run");
      expect(err.message).toContain("timeout");
    }
  });
});
