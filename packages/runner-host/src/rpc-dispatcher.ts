/**
 * SP-3 host-side RPC dispatcher.
 *
 * Translates a typed `HostRpcRequest` (cloud → host) into the right handler
 * call and packages the outcome into a `HostRpcResponse`. The dispatcher
 * itself does NO disk / process work — handlers are injected via `deps` so
 * the dispatcher unit-tests cleanly with mocks.
 *
 * Validation strategy:
 *   - Inbound frames are zod-validated at the WS boundary (in main.ts) using
 *     `hostRpcRequestSchema`. This dispatcher trusts its input is already
 *     a discriminated-union-correct shape.
 *   - Outbound frames are zod-validated against `hostRpcResponseSchema` so a
 *     handler bug producing a malformed response doesn't poison the wire.
 *
 * Error handling: any thrown error from a handler is caught and converted to
 * `{ ok: false, method, error: { code, message } }`. `GitOpError` /
 * `FsBrowseError` carry a stable `code`; anything else becomes
 * `code: "internal"`.
 */

import {
  hostRpcResponseSchema,
  type HostRpcRequest,
  type HostRpcResponse,
  type GitInitIfMissingRequest,
  type GitInitIfMissingResponse,
  type GitWorktreeCreateRequest,
  type GitWorktreeCreateResponse,
  type GitWorktreeRemoveRequest,
  type GitWorktreeRemoveResponse,
  type GitMergeToMainRequest,
  type GitMergeToMainResponse,
  type GitPushToRemoteRequest,
  type GitPushToRemoteResponse,
  type GitTestsRunRequest,
  type GitTestsRunResponse,
  type GitDiffSnapshotRequest,
  type GitDiffSnapshotResponse,
  type FsBrowseRequest,
  type FsBrowseResponse,
  type ReadFileRequest,
  type ReadFileResponse,
  type GenerateThreadTitleRequest,
  type GenerateThreadTitleResponse,
} from "@cogni/contract";
import { GitOpError } from "./git-ops.js";
import { FsBrowseError } from "./fs-browse.js";
import { GenerateTitleError } from "./generate-title.js";

export interface RpcDeps {
  gitInitIfMissing: (req: GitInitIfMissingRequest) => Promise<GitInitIfMissingResponse>;
  gitWorktreeCreate: (req: GitWorktreeCreateRequest) => Promise<GitWorktreeCreateResponse>;
  gitWorktreeRemove: (req: GitWorktreeRemoveRequest) => Promise<GitWorktreeRemoveResponse>;
  gitMergeToMain: (req: GitMergeToMainRequest) => Promise<GitMergeToMainResponse>;
  gitPushToRemote: (req: GitPushToRemoteRequest) => Promise<GitPushToRemoteResponse>;
  gitTestsRun: (req: GitTestsRunRequest) => Promise<GitTestsRunResponse>;
  gitDiffSnapshot: (req: GitDiffSnapshotRequest) => Promise<GitDiffSnapshotResponse>;
  fsBrowse: (req: FsBrowseRequest) => Promise<FsBrowseResponse>;
  readFile: (req: ReadFileRequest) => Promise<ReadFileResponse>;
  generateThreadTitle: (req: GenerateThreadTitleRequest) => Promise<GenerateThreadTitleResponse>;
}

/**
 * Route one validated request to its handler and produce a typed response.
 *
 * The outer try/catch reports any thrown error as an `ok:false` frame; this
 * is intentionally exception-of-last-resort — handlers are expected to throw
 * `GitOpError` / `FsBrowseError` for known conditions (those preserve a
 * meaningful `code`).
 */
export async function dispatchHostRpc(
  frame: HostRpcRequest,
  deps: RpcDeps,
): Promise<HostRpcResponse> {
  let resp: HostRpcResponse;
  try {
    resp = await routeRpc(frame, deps);
  } catch (e: unknown) {
    resp = {
      ok: false,
      method: frame.method,
      error: errorPayload(e),
    };
  }
  // Defensive: validate the outgoing frame. If a handler produces something
  // off-shape (e.g. extra field, wrong type) we'd rather catch it here than
  // ship malformed JSON to the cloud. Convert to a generic error frame.
  const parsed = hostRpcResponseSchema.safeParse(resp);
  if (!parsed.success) {
    return {
      ok: false,
      method: frame.method,
      error: {
        code: "response-validation-failed",
        message: parsed.error.message,
      },
    };
  }
  return parsed.data;
}

async function routeRpc(frame: HostRpcRequest, deps: RpcDeps): Promise<HostRpcResponse> {
  switch (frame.method) {
    case "git-init-if-missing":
      return { ok: true, method: frame.method, result: await deps.gitInitIfMissing(frame.params) };
    case "git-worktree-create":
      return { ok: true, method: frame.method, result: await deps.gitWorktreeCreate(frame.params) };
    case "git-worktree-remove":
      return { ok: true, method: frame.method, result: await deps.gitWorktreeRemove(frame.params) };
    case "git-merge-to-main":
      return { ok: true, method: frame.method, result: await deps.gitMergeToMain(frame.params) };
    case "git-push-to-remote":
      return { ok: true, method: frame.method, result: await deps.gitPushToRemote(frame.params) };
    case "git-tests-run":
      return { ok: true, method: frame.method, result: await deps.gitTestsRun(frame.params) };
    case "git-diff-snapshot":
      return { ok: true, method: frame.method, result: await deps.gitDiffSnapshot(frame.params) };
    case "fs-browse":
      return { ok: true, method: frame.method, result: await deps.fsBrowse(frame.params) };
    case "read-file":
      return { ok: true, method: frame.method, result: await deps.readFile(frame.params) };
    case "generate-thread-title":
      return { ok: true, method: frame.method, result: await deps.generateThreadTitle(frame.params) };
  }
}

function errorPayload(e: unknown): { code: string; message: string } {
  if (e instanceof GitOpError || e instanceof FsBrowseError || e instanceof GenerateTitleError) {
    return { code: e.code, message: e.message };
  }
  if (e instanceof Error) {
    return { code: "internal", message: e.message };
  }
  return { code: "internal", message: String(e) };
}
