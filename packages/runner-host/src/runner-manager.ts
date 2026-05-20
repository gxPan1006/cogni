import { mkdir } from "node:fs/promises";
import type { RunnerAdapter, RunnerEvent, RunnerSessionHandle, StartSessionOpts } from "@cogni/contract";
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
}

/** Holds registered adapters + live session handles, runs one turn per dispatch. */
export class RunnerManager {
  private adapters = new Map<string, RunnerAdapter>();
  private sessions = new Map<string, RunnerSessionHandle>(); // cloud sessionId → handle

  register(adapter: RunnerAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  capabilities(): { adapters: string[]; capabilities: string[] } {
    const caps = new Set<string>();
    for (const a of this.adapters.values()) for (const c of a.capabilities) caps.add(c);
    return { adapters: [...this.adapters.keys()], capabilities: [...caps] };
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
    // BEFORE the runner starts, so Claude Code can read them. Runs for both the
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
        }
      : { cwd };

    let handle = this.sessions.get(input.sessionId);
    if (!handle) {
      handle = input.runnerSessionId
        ? await adapter.resumeSession(input.runnerSessionId, opts)
        : await adapter.startSession(opts);
      this.sessions.set(input.sessionId, handle);
    }
    try {
      for await (const event of handle.send(input.message)) onEvent(event);
    } catch (err) {
      // Adapter-agnostic safety net: a well-behaved adapter yields an `error`
      // event, but a misbehaving one could throw. Don't let that reject
      // dispatch — that would strand the cloud-side session in `running`.
      onEvent({ type: "error", code: "adapter_threw", message: String(err) });
    }
  }
}
