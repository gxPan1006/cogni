/**
 * SP-3 cloud-side typed wrapper around the host RPC envelope.
 *
 * `HostRpcClient` is the one place where the orchestrator + use-cases talk
 * to a runner host's local-disk surface (git ops + fs-browse). It speaks in
 * method-specific request/response *result* types and hides the rpcId /
 * envelope / timeout plumbing — that lives in `routes/host-ws.ts`'s
 * `sendHostRpc` (which we receive via DI).
 *
 * Error model:
 *   - host returned `{ ok: false }`  → throw `HostRpcError(method, code, message)`
 *   - host offline / WS write failed → host-ws throws — we re-wrap into a
 *     `HostRpcError` with `code='host-offline'` so callers have one error type
 *     to catch.
 *   - timeout                        → host-ws rejects with code='rpc-timeout';
 *     we re-wrap into `HostRpcError` too.
 *
 * Why the DI'd `sendHostRpc`: it lets tests mock the transport with a plain
 * function instead of standing up a WS pair, and it keeps `client-hub` / `routes`
 * out of this domain layer's import graph.
 */

import type {
  HostRpcRequest,
  HostRpcResponse,
  GitInitIfMissingRequest,
  GitInitIfMissingResponse,
  GitWorktreeCreateRequest,
  GitWorktreeCreateResponse,
  GitWorktreeRemoveRequest,
  GitWorktreeRemoveResponse,
  GitMergeToMainRequest,
  GitMergeToMainResponse,
  GitPushToRemoteRequest,
  GitPushToRemoteResponse,
  GitTestsRunRequest,
  GitTestsRunResponse,
  GitDiffSnapshotRequest,
  GitDiffSnapshotResponse,
  FsBrowseRequest,
  FsBrowseResponse,
  ReadFileRequest,
  ReadFileResponse,
  HostRpcMethod,
} from "@cogni/contract";

export type SendHostRpcFn = (hostId: string, request: HostRpcRequest) => Promise<HostRpcResponse>;

export class HostRpcError extends Error {
  constructor(
    public readonly method: HostRpcMethod | "unknown",
    public readonly code: string,
    message: string,
  ) {
    super(`[host-rpc:${method}] ${code}: ${message}`);
    this.name = "HostRpcError";
  }
}

export interface HostRpcLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  debug?: (obj: Record<string, unknown>, msg: string) => void;
}

export interface HostRpcClientDeps {
  sendHostRpc: SendHostRpcFn;
  logger?: HostRpcLogger;
}

/**
 * Method-typed wrapper. Each method:
 *   1. packs `{ method, params }` into a `HostRpcRequest`
 *   2. delegates to the injected transport
 *   3. validates `response.ok === true` and narrows to the method-specific
 *      `result` (the contract's `hostRpcResponseSchema` union shape — see
 *      `host-protocol.ts` for why it's a plain z.union)
 *   4. throws `HostRpcError` on the error branch.
 *
 * The runtime narrowing on `response.method === method` is belt-and-braces:
 * a well-behaved host always echoes the same method literal, but if a host
 * bug ever returns the wrong success variant we surface it as a typed error
 * rather than silently returning the wrong shape.
 */
export class HostRpcClient {
  constructor(private readonly deps: HostRpcClientDeps) {}

  async gitInitIfMissing(hostId: string, params: GitInitIfMissingRequest): Promise<GitInitIfMissingResponse> {
    return this.call(hostId, "git-init-if-missing", params) as Promise<GitInitIfMissingResponse>;
  }
  async gitWorktreeCreate(hostId: string, params: GitWorktreeCreateRequest): Promise<GitWorktreeCreateResponse> {
    return this.call(hostId, "git-worktree-create", params) as Promise<GitWorktreeCreateResponse>;
  }
  async gitWorktreeRemove(hostId: string, params: GitWorktreeRemoveRequest): Promise<GitWorktreeRemoveResponse> {
    return this.call(hostId, "git-worktree-remove", params) as Promise<GitWorktreeRemoveResponse>;
  }
  async gitMergeToMain(hostId: string, params: GitMergeToMainRequest): Promise<GitMergeToMainResponse> {
    return this.call(hostId, "git-merge-to-main", params) as Promise<GitMergeToMainResponse>;
  }
  async gitPushToRemote(hostId: string, params: GitPushToRemoteRequest): Promise<GitPushToRemoteResponse> {
    return this.call(hostId, "git-push-to-remote", params) as Promise<GitPushToRemoteResponse>;
  }
  async gitTestsRun(hostId: string, params: GitTestsRunRequest): Promise<GitTestsRunResponse> {
    return this.call(hostId, "git-tests-run", params) as Promise<GitTestsRunResponse>;
  }
  async gitDiffSnapshot(hostId: string, params: GitDiffSnapshotRequest): Promise<GitDiffSnapshotResponse> {
    return this.call(hostId, "git-diff-snapshot", params) as Promise<GitDiffSnapshotResponse>;
  }
  async fsBrowse(hostId: string, params: FsBrowseRequest): Promise<FsBrowseResponse> {
    return this.call(hostId, "fs-browse", params) as Promise<FsBrowseResponse>;
  }
  async readFile(hostId: string, params: ReadFileRequest): Promise<ReadFileResponse> {
    return this.call(hostId, "read-file", params) as Promise<ReadFileResponse>;
  }

  private async call(
    hostId: string,
    method: HostRpcMethod,
    // The contract's discriminated union of `{ method, params }` would give
    // perfect static typing here, but TS can't narrow `params` per-method
    // when the method literal is a runtime variable. We cast through `unknown`
    // — each public method above is the typed boundary so callers stay safe.
    params: unknown,
  ): Promise<unknown> {
    let response: HostRpcResponse;
    try {
      response = await this.deps.sendHostRpc(hostId, {
        method,
        params,
      } as HostRpcRequest);
    } catch (err) {
      // host-ws rejects with `{ code, message }` from in-flight table; coerce
      // unknown shapes too so callers always see HostRpcError.
      const code = isErrLike(err) ? err.code : "host-unreachable";
      const message = isErrLike(err) ? err.message : String(err);
      this.deps.logger?.warn?.({ hostId, method, code, message }, "host-rpc transport error");
      throw new HostRpcError(method, code, message);
    }
    if (response.ok === true) {
      if (response.method !== method) {
        // Defensive: contract guarantees method echo, but a misbehaving host
        // should not silently corrupt narrowing.
        throw new HostRpcError(method, "method-mismatch", `expected ${method}, got ${response.method}`);
      }
      return response.result;
    }
    // error branch
    this.deps.logger?.debug?.(
      { hostId, method, code: response.error.code, message: response.error.message },
      "host-rpc returned error",
    );
    throw new HostRpcError(response.method, response.error.code, response.error.message);
  }
}

function isErrLike(err: unknown): err is { code: string; message: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { code?: unknown }).code === "string" &&
    typeof (err as { message?: unknown }).message === "string"
  );
}
