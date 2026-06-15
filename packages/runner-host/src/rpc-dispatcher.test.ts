import { describe, it, expect, vi } from "vitest";
import type { HostRpcRequest } from "@cogni/contract";
import { dispatchHostRpc, type RpcDeps } from "./rpc-dispatcher.js";
import { GitOpError } from "./git-ops.js";
import { FsBrowseError } from "./fs-browse.js";
import { UploadError } from "./uploads.js";

/** Stub deps where every handler defaults to a "should not be called" guard. */
function depsWith(overrides: Partial<RpcDeps>): RpcDeps {
  const must = (name: string) =>
    vi.fn(async () => {
      throw new Error(`unexpected call to ${name}`);
    });
  return {
    gitInitIfMissing: must("gitInitIfMissing"),
    gitWorktreeCreate: must("gitWorktreeCreate"),
    gitWorktreeRemove: must("gitWorktreeRemove"),
    gitMergeToMain: must("gitMergeToMain"),
    gitPushToRemote: must("gitPushToRemote"),
    gitTestsRun: must("gitTestsRun"),
    gitDiffSnapshot: must("gitDiffSnapshot"),
    fsBrowse: must("fsBrowse"),
    readFile: must("readFile"),
    ...overrides,
  };
}

describe("dispatchHostRpc", () => {
  it("routes git-init-if-missing to its handler and wraps the result", async () => {
    const handler = vi.fn(async () => ({ initialized: true }));
    const frame: HostRpcRequest = {
      method: "git-init-if-missing",
      params: { repoPath: "/r" },
    };
    const resp = await dispatchHostRpc(frame, depsWith({ gitInitIfMissing: handler }));
    expect(handler).toHaveBeenCalledWith({ repoPath: "/r" });
    expect(resp).toEqual({
      ok: true,
      method: "git-init-if-missing",
      result: { initialized: true },
    });
  });

  it("routes fs-browse to its handler", async () => {
    const handler = vi.fn(async () => ({
      cwd: "/Users/me",
      entries: [{ name: "code", type: "dir" as const }],
    }));
    const resp = await dispatchHostRpc(
      { method: "fs-browse", params: { path: "/Users/me" } },
      depsWith({ fsBrowse: handler }),
    );
    expect(handler).toHaveBeenCalled();
    expect(resp).toEqual({
      ok: true,
      method: "fs-browse",
      result: { cwd: "/Users/me", entries: [{ name: "code", type: "dir" }] },
    });
  });

  it("converts a GitOpError into a structured ok=false frame with its code", async () => {
    const handler = vi.fn(async () => {
      throw new GitOpError("worktree-outside-repo", "boom");
    });
    const resp = await dispatchHostRpc(
      {
        method: "git-worktree-create",
        params: { repoPath: "/r", branchName: "task/x", worktreePath: "/elsewhere" },
      },
      depsWith({ gitWorktreeCreate: handler }),
    );
    expect(resp).toEqual({
      ok: false,
      method: "git-worktree-create",
      error: { code: "worktree-outside-repo", message: "boom" },
    });
  });

  it("converts an FsBrowseError into a structured ok=false frame", async () => {
    const handler = vi.fn(async () => {
      throw new FsBrowseError("path-not-found", "no such path");
    });
    const resp = await dispatchHostRpc(
      { method: "fs-browse", params: { path: "/ghost" } },
      depsWith({ fsBrowse: handler }),
    );
    expect(resp).toEqual({
      ok: false,
      method: "fs-browse",
      error: { code: "path-not-found", message: "no such path" },
    });
  });

  it("falls back to code='internal' for unknown thrown values", async () => {
    const handler = vi.fn(async () => {
      throw new Error("oops");
    });
    const resp = await dispatchHostRpc(
      {
        method: "git-tests-run",
        params: { worktreePath: "/w", command: "pnpm t", timeoutMs: 1000 },
      },
      depsWith({ gitTestsRun: handler }),
    );
    expect(resp.ok).toBe(false);
    if (resp.ok === false) {
      expect(resp.error).toEqual({ code: "internal", message: "oops" });
    }
  });

  it("catches a malformed handler response via outbound schema validation", async () => {
    // Handler returns the wrong shape — `removed` should be a boolean.
    // Cast through `unknown` is intentional: we're simulating a bug.
    const handler = vi.fn(async () => ({ removed: "yes" }) as unknown as { removed: boolean });
    const resp = await dispatchHostRpc(
      { method: "git-worktree-remove", params: { worktreePath: "/r/.wt/x", force: false } },
      depsWith({ gitWorktreeRemove: handler }),
    );
    expect(resp.ok).toBe(false);
    if (resp.ok === false) {
      expect(resp.error.code).toBe("response-validation-failed");
    }
  });

  it("uses the response schema's narrowed types per method", async () => {
    // git-tests-run requires exitCode + stdoutTail + stderrTail; a complete
    // shape must pass validation untouched.
    const handler = vi.fn(async () => ({ exitCode: 0, stdoutTail: "ok\n", stderrTail: "" }));
    const resp = await dispatchHostRpc(
      {
        method: "git-tests-run",
        params: { worktreePath: "/w", command: "true", timeoutMs: 1000 },
      },
      depsWith({ gitTestsRun: handler }),
    );
    expect(resp.ok).toBe(true);
    if (resp.ok === true && resp.method === "git-tests-run") {
      expect(resp.result.exitCode).toBe(0);
    }
  });
});

function deps(over: Partial<RpcDeps>): RpcDeps {
  const stub = vi.fn();
  return {
    gitInitIfMissing: stub, gitWorktreeCreate: stub, gitWorktreeRemove: stub,
    gitMergeToMain: stub, gitPushToRemote: stub, gitTestsRun: stub,
    gitDiffSnapshot: stub, fsBrowse: stub, readFile: stub, generateThreadTitle: stub,
    uploadBegin: stub, uploadChunk: stub, uploadCommit: stub, uploadAbort: stub,
    setProjectsRoot: stub, setKeepAwake: stub, setDefaultAdapter: stub,
    ...over,
  } as RpcDeps;
}

describe("dispatchHostRpc upload arms", () => {
  it("routes upload-begin to deps.uploadBegin", async () => {
    const uploadBegin = vi.fn().mockResolvedValue({ uploadId: "u1" });
    const resp = await dispatchHostRpc(
      { method: "upload-begin", params: { scope: { kind: "thread", threadId: "t1" }, fileName: "a", declaredSize: 1 } },
      deps({ uploadBegin }),
    );
    expect(uploadBegin).toHaveBeenCalled();
    expect(resp).toMatchObject({ ok: true, method: "upload-begin", result: { uploadId: "u1" } });
  });

  it("maps an UploadError to ok:false with its code", async () => {
    const uploadCommit = vi.fn().mockRejectedValue(new UploadError("upload-not-found", "nope"));
    const resp = await dispatchHostRpc(
      { method: "upload-commit", params: { uploadId: "x" } },
      deps({ uploadCommit }),
    );
    expect(resp).toMatchObject({ ok: false, method: "upload-commit", error: { code: "upload-not-found" } });
  });

  it("routes set-projects-root", async () => {
    const setProjectsRoot = vi.fn().mockResolvedValue({ projectsRoot: "/Users/x/cogni", locked: false });
    const resp = await dispatchHostRpc(
      { method: "set-projects-root", params: { projectsRoot: "~/cogni" } },
      deps({ setProjectsRoot }),
    );
    expect(setProjectsRoot).toHaveBeenCalled();
    expect(resp).toEqual({
      ok: true,
      method: "set-projects-root",
      result: { projectsRoot: "/Users/x/cogni", locked: false },
    });
  });

  it("routes set-default-adapter", async () => {
    const setDefaultAdapter = vi.fn().mockResolvedValue({ defaultAdapter: "claude-code-snapshot" });
    const resp = await dispatchHostRpc(
      { method: "set-default-adapter", params: { defaultAdapter: "claude-code-snapshot" } },
      deps({ setDefaultAdapter }),
    );
    expect(setDefaultAdapter).toHaveBeenCalled();
    expect(resp).toEqual({
      ok: true,
      method: "set-default-adapter",
      result: { defaultAdapter: "claude-code-snapshot" },
    });
  });
});
