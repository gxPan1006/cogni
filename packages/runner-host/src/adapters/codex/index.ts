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
  RunnerCommandId,
  RunnerEvent,
  RunnerSessionHandle,
  StartSessionOpts,
} from "@cogni/contract";
import { defaultCodexRunner, translateCodexLine, type CodexRunner } from "./codex-process.js";

const CAPABILITIES: RunnerCapability[] = ["streaming", "tool-events"];

class CodexSession implements RunnerSessionHandle {
  private _runnerSessionId: string | null = null;
  // The live turn's iterator, held so `interrupt()` can `.return()` it —
  // which runs the runner generator's `finally` (kills the codex child) and
  // ends the `for await` loop, yielding a clean terminal `done` below.
  private activeIterator: AsyncIterator<string> | null = null;
  constructor(
    private readonly runner: CodexRunner,
    private readonly cwd: string,
    private readonly appendSystemPrompt?: string,
  ) {}

  get runnerSessionId(): string | null {
    return this._runnerSessionId;
  }

  async *send(message: string): AsyncIterable<RunnerEvent> {
    let sawTerminal = false;
    const effectiveMessage = this.appendSystemPrompt
      ? `${this.appendSystemPrompt}\n\n${message}`
      : message;
    const iterator = this.runner({ cwd: this.cwd, message: effectiveMessage })[Symbol.asyncIterator]();
    this.activeIterator = iterator;
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        for (const event of translateCodexLine(next.value)) {
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
    } finally {
      this.activeIterator = null;
    }
    // Reaching here without a codex-emitted terminal means either a normal
    // stdout end or a user stop (interrupt closed the iterator): either way
    // the turn is over, so present a clean `done`.
    if (!sawTerminal) yield { type: "done" };
  }

  /** Stop the in-flight turn by closing the codex stdout iterator. */
  interrupt(): void {
    void this.activeIterator?.return?.(undefined);
  }

  async close(): Promise<void> {
    // No persistent process between turns: each `send()` invocation spawns
    // a fresh `codex exec`. Matches Claude Code adapter semantics.
  }
}

export class CodexAdapter implements RunnerAdapter {
  readonly id = "codex" as const;
  readonly capabilities = CAPABILITIES;
  // Codex can reset context but cannot fork a session (no `--fork-session`),
  // so it advertises clear only — branch stays claude-code-specific.
  readonly commands: readonly RunnerCommandId[] = ["clear"];
  constructor(private readonly runner: CodexRunner = defaultCodexRunner) {}

  async startSession(opts: StartSessionOpts): Promise<RunnerSessionHandle> {
    return new CodexSession(this.runner, opts.cwd, opts.appendSystemPrompt);
  }

  async resumeSession(): Promise<RunnerSessionHandle> {
    // SP-3 §八: Codex retry is cold-start. Callers MUST check
    // `adapter.capabilities.includes("session-resume")` first; reaching this
    // line is a programming error.
    throw new Error("codex adapter does not support resume");
  }
}
