import { mkdir } from "node:fs/promises";
import type { RunnerAdapter, RunnerCommandId, RunnerEvent, RunnerSessionHandle, StartSessionOpts } from "@cogni/contract";
import { threadScratchDir } from "./config.js";
import { ensureCogniMcpConfig, COGNI_ALLOWED_TOOLS } from "./mcp/mcp-config.js";
import { materializeUploads } from "./uploads.js";

export interface DispatchInput {
  sessionId: string;
  threadId: string;
  adapter: string;
  runnerSessionId: string | null;
  message: string;
  /**
   * SP-3: project-task dispatches set this to the per-task worktree path so
   * the runner runs inside the right git tree (spec §七 invariant 3). When
   * omitted (chat-only flow, SP-1/SP-2), we fall back to the per-thread
   * scratch dir as before.
   */
  workspacePath?: string;
  /**
   * SP-4: Workspace Chat orchestrator dispatch. When set, the runner is
   * launched with the cogni stdio MCP server (`--mcp-config`) and restricted
   * to the cogni tool allowlist, so it drives project/task mutations via cloud
   * REST instead of touching files.
   */
  orchestrator?: boolean;
  /**
   * SP-4: extra system-prompt text for this turn (orchestrator preamble),
   * passed to the adapter as `--append-system-prompt`. Sent every turn so
   * resumed sessions keep the framing.
   */
  appendSystemPrompt?: string;
  /**
   * Files the user attached this turn. Copied from the host staging dir into
   * <cwd>/.cogni-uploads/ before the runner starts. Absent for turns with none.
   */
  attachments?: { name: string }[];
  /** Chat model id (a CHAT_MODELS id) → `claude --model <id>`. Absent ⇒ CLI default. */
  model?: string;
  /**
   * Branch: fork this parent runner-session id (`--fork-session`) when first
   * spawning the handle, instead of resuming `runnerSessionId`. Set only on a
   * branched thread's first dispatch.
   */
  forkFromRunnerSessionId?: string;
}

/**
 * Subset of a dispatch needed to spawn the runner process ahead of the first
 * turn. No `message` — prewarm only boots the process; the prompt comes later.
 */
export interface PrewarmInput {
  sessionId: string;
  threadId: string;
  adapter: string;
  runnerSessionId: string | null;
  workspacePath?: string;
  orchestrator?: boolean;
  appendSystemPrompt?: string;
  model?: string;
}

/**
 * Max concurrent warm session handles (each may wrap a live `claude` process).
 * Prewarm + warm reuse keep processes alive across turns, so without a bound a
 * user opening many fresh chats (or abandoning prewarmed ones) would pile up
 * processes. On overflow the least-recently-used handle is closed; its next
 * dispatch simply respawns (or `--resume`s) — no correctness loss, just a cold
 * start for that session again.
 */
const MAX_WARM_SESSIONS = 8;

/** Holds registered adapters + live session handles, runs one turn per dispatch. */
export class RunnerManager {
  private adapters = new Map<string, RunnerAdapter>();
  // cloud sessionId → handle. Insertion order is the LRU order: `touch()`
  // re-inserts a session as most-recently-used; overflow evicts from the front.
  private sessions = new Map<string, RunnerSessionHandle>();

  register(adapter: RunnerAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  capabilities(): { adapters: string[]; capabilities: string[]; adapterCommands: Record<string, RunnerCommandId[]> } {
    const caps = new Set<string>();
    const adapterCommands: Record<string, RunnerCommandId[]> = {};
    for (const a of this.adapters.values()) {
      for (const c of a.capabilities) caps.add(c);
      adapterCommands[a.id] = [...a.commands];
    }
    return { adapters: [...this.adapters.keys()], capabilities: [...caps], adapterCommands };
  }

  /**
   * Stop the in-flight turn for `sessionId` (cloud `interrupt` → composer ■).
   * Best-effort: no-op if there's no live handle (turn already finished) or the
   * adapter can't interrupt mid-turn. The handle's own `send()` iterator then
   * terminates with a `done` like any turn boundary, so the cloud's normal
   * session-update path fires — no extra cleanup here.
   */
  interrupt(sessionId: string): void {
    this.sessions.get(sessionId)?.interrupt?.();
  }

  /**
   * Run one turn for `input.sessionId`, forwarding every RunnerEvent to `onEvent`.
   *
   * Callers MUST serialize dispatch per `sessionId`: the get-or-create handle
   * cache is check-then-act and not concurrency-safe. In SP-1 the cloud
   * serializes per-session dispatch upstream, so this holds.
   *
   * SP-2 follow-ups: (a) cache the handle *promise* so concurrent same-session
   * callers share one creation; (b) add a `closeSession(sessionId)` eviction
   * path — the `sessions` Map currently grows unbounded and each handle may
   * wrap a live child process.
   */
  async dispatch(input: DispatchInput, onEvent: (e: RunnerEvent) => void): Promise<void> {
    const adapter = this.adapters.get(input.adapter);
    if (!adapter) {
      onEvent({ type: "error", code: "unknown_adapter", message: `no adapter registered for '${input.adapter}'` });
      return;
    }
    // SP-3: project-task dispatches override cwd to the task's worktree
    // (spec §七 invariant 3). The worktree is created via host RPC before
    // dispatch, so it already exists — no mkdir. Chat-only flow keeps the
    // SP-1 thread-scratch-dir behavior (lazy mkdir).
    const cwd = input.workspacePath ?? threadScratchDir(input.threadId);
    if (!input.workspacePath) {
      await mkdir(cwd, { recursive: true });
    }

    // File-upload: copy this turn's staged attachments into <cwd>/.cogni-uploads/
    // BEFORE the runner starts, so the selected adapter can read them. Runs for both the
    // chat scratch dir and the project-task worktree; materializeUploads mkdirs
    // the target subdir and (for worktrees) adds a git exclude.
    if (input.attachments && input.attachments.length > 0) {
      await materializeUploads(input.threadId, input.attachments, cwd);
    }

    // SP-4: orchestrator dispatches mount the cogni MCP server + tool allowlist;
    // ordinary chat/task dispatches leave these unset.
    const opts: StartSessionOpts = input.orchestrator
      ? {
          cwd,
          mcpConfigPath: ensureCogniMcpConfig(),
          allowedTools: [...COGNI_ALLOWED_TOOLS],
          ...(input.appendSystemPrompt ? { appendSystemPrompt: input.appendSystemPrompt } : {}),
          ...(input.model ? { model: input.model } : {}),
        }
      : { cwd, ...(input.model ? { model: input.model } : {}) };
    // Branch: the first dispatch of a branched thread forks the parent session.
    if (input.forkFromRunnerSessionId) opts.fork = true;

    const handle = await this.getOrCreateHandle(input, adapter, opts);
    try {
      for await (const event of handle.send(input.message)) onEvent(event);
    } catch (err) {
      // Adapter-agnostic safety net: a well-behaved adapter yields an `error`
      // event, but a misbehaving one could throw. Don't let that reject
      // dispatch — that would strand the cloud-side session in `running`.
      onEvent({ type: "error", code: "adapter_threw", message: String(err) });
    }
    // Warm-process adapters mark `closed` once their persistent process exits.
    // Evict so the next dispatch spawns (or `--resume`s) a fresh one instead of
    // reusing a dead handle that would only yield errors.
    if (handle.closed) this.sessions.delete(input.sessionId);
  }

  /**
   * SP follow-up (prewarm): spawn the runner process for `sessionId` ahead of
   * the first dispatch so its cold start is paid while the user is still
   * composing. Idempotent — a no-op if a handle already exists or the adapter
   * doesn't support warmup. Errors are swallowed: prewarm is best-effort and
   * must never break the (later) real dispatch.
   */
  async prewarm(input: PrewarmInput): Promise<void> {
    const adapter = this.adapters.get(input.adapter);
    if (!adapter) return;
    if (this.sessions.has(input.sessionId)) return;
    const cwd = input.workspacePath ?? threadScratchDir(input.threadId);
    try {
      if (!input.workspacePath) await mkdir(cwd, { recursive: true });
      const opts: StartSessionOpts = input.orchestrator
        ? {
            cwd,
            mcpConfigPath: ensureCogniMcpConfig(),
            allowedTools: [...COGNI_ALLOWED_TOOLS],
            ...(input.appendSystemPrompt ? { appendSystemPrompt: input.appendSystemPrompt } : {}),
            ...(input.model ? { model: input.model } : {}),
          }
        : { cwd, ...(input.model ? { model: input.model } : {}) };
      const canResume = adapter.capabilities.includes("session-resume");
      const handle = input.runnerSessionId && canResume
        ? await adapter.resumeSession(input.runnerSessionId, opts)
        : await adapter.startSession(opts);
      this.cacheSet(input.sessionId, handle);
      await handle.warmup?.();
    } catch {
      // best-effort; the real dispatch will spawn lazily if this failed.
    }
  }

  /** Get the cached handle for a session, or create one. Evicts dead handles first. */
  private async getOrCreateHandle(
    input: DispatchInput,
    adapter: RunnerAdapter,
    opts: StartSessionOpts,
  ): Promise<RunnerSessionHandle> {
    const cached = this.sessions.get(input.sessionId);
    if (cached && !cached.closed) {
      this.touch(input.sessionId, cached);
      return cached;
    }
    // Branch forks the parent session id; otherwise resume our own (if any).
    const resumeId = input.forkFromRunnerSessionId ?? input.runnerSessionId;
    const canResume = adapter.capabilities.includes("session-resume");
    const handle = resumeId && canResume
      ? await adapter.resumeSession(resumeId, opts)
      : await adapter.startSession(opts);
    this.cacheSet(input.sessionId, handle);
    return handle;
  }

  /** Mark a session most-recently-used (re-insert at the back of the Map). */
  private touch(sessionId: string, handle: RunnerSessionHandle): void {
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, handle);
  }

  /** Insert a handle as most-recently-used, evicting LRU handles past the cap. */
  private cacheSet(sessionId: string, handle: RunnerSessionHandle): void {
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, handle);
    while (this.sessions.size > MAX_WARM_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === sessionId) break;
      const victim = this.sessions.get(oldest);
      this.sessions.delete(oldest);
      void victim?.close().catch(() => {});
    }
  }

  /** Kill every live session handle. Called on host shutdown. */
  async closeAll(): Promise<void> {
    const handles = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(handles.map((h) => h.close().catch(() => {})));
  }
}
