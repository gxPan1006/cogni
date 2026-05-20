/**
 * SP-3 Codex CLI adapter — the second runner-host adapter alongside
 * `claude-code`. Pairs with `codex-process.ts` (which owns the spawn +
 * stdout-translation seams).
 *
 * Why this adapter exists at all: per spec §八, the SP-3 capability
 * abstraction "Retry pulls a different code path depending on
 * session-resume support" only earns its keep with a second adapter. Codex
 * is the contrast point — it deliberately does NOT declare `session-resume`
 * (cold-start per retry) and does NOT declare `permission-prompt`
 * (`--dangerously-bypass-approvals-and-sandbox` is unconditional).
 *
 * Declared capabilities:
 *   - "streaming"    JSONL stdout → RunnerEvent stream, one line at a time
 *   - "tool-events"  emits tool-call + tool-result for command_execution items
 *
 * NOT declared:
 *   - "session-resume"     — `resumeSession` throws (see below)
 *   - "permission-prompt"  — Codex runs in AFK mode and bypasses approvals
 *
 * resumeSession contract: throws synchronously (well, rejects). The cloud
 * lifecycle (SP-3 retry policy) checks `adapter.capabilities` before deciding
 * cold-start vs resume; calling `resumeSession` on a Codex handle is a bug.
 */

import type {
  RunnerAdapter,
  RunnerCapability,
  RunnerEvent,
  RunnerSessionHandle,
  StartSessionOpts,
} from "@cogni/contract";
import { defaultCodexRunner, translateCodexLine, type CodexRunner } from "./codex-process.js";

const CAPABILITIES: RunnerCapability[] = ["streaming", "tool-events"];

class CodexSession implements RunnerSessionHandle {
  private _runnerSessionId: string | null = null;
  constructor(
    private readonly runner: CodexRunner,
    private readonly cwd: string,
  ) {}

  get runnerSessionId(): string | null {
    return this._runnerSessionId;
  }

  async *send(message: string): AsyncIterable<RunnerEvent> {
    let sawTerminal = false;
    try {
      for await (const line of this.runner({ cwd: this.cwd, message })) {
        for (const event of translateCodexLine(line)) {
          if (event.type === "session-id") this._runnerSessionId = event.id;
          if (event.type === "done" || event.type === "error") sawTerminal = true;
          yield event;
        }
      }
    } catch (e) {
      // Mirrors ClaudeCodeAdapter: convert any spawn-level exception into a
      // single terminal `error` event so the dispatcher's session-update
      // path still fires.
      yield { type: "error", code: "codex_spawn_failed", message: String(e) };
      return;
    }
    if (!sawTerminal) yield { type: "done" };
  }

  async close(): Promise<void> {
    // No persistent process between turns: each `send()` invocation spawns
    // a fresh `codex exec`. Matches Claude Code adapter semantics.
  }
}

export class CodexAdapter implements RunnerAdapter {
  readonly id = "codex" as const;
  readonly capabilities = CAPABILITIES;
  constructor(private readonly runner: CodexRunner = defaultCodexRunner) {}

  async startSession(opts: StartSessionOpts): Promise<RunnerSessionHandle> {
    return new CodexSession(this.runner, opts.cwd);
  }

  async resumeSession(): Promise<RunnerSessionHandle> {
    // SP-3 §八: Codex retry is cold-start. Callers MUST check
    // `adapter.capabilities.includes("session-resume")` first; reaching this
    // line is a programming error.
    throw new Error("codex adapter does not support resume");
  }
}
