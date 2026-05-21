import { z } from "zod";

export const RUNNER_CAPABILITIES = [
  "streaming",
  "session-resume",
  "tool-events",
  "permission-prompt",
  "memory-injection",
  "active-injection",
  "attachments",
] as const;
export type RunnerCapability = (typeof RUNNER_CAPABILITIES)[number];

/**
 * Runner-scoped chat commands — the "slash commands" surfaced in the composer.
 *
 * These are SEMANTIC ids, not literal slash strings: each adapter maps the id
 * to its own implementation, and the names a runner exposes in its native TUI
 * (Claude Code's `/clear`, `/branch`; Codex's own set) don't have to match. The
 * cloud + UI only ever speak these ids, so adding a runner means declaring its
 * supported ids on its adapter — no cloud/UI change.
 *
 *   - "clear"  reset the thread's runner context (keeps scrollback; next turn
 *              starts a fresh session). Implemented cloud-side, not dispatched.
 *   - "branch" fork the conversation into a new thread inheriting context up to
 *              this point (Claude Code: `--fork-session`).
 *
 * NOTE: rewind is intentionally absent — it depends on a checkpoint story not
 * yet wired through the `--print` runner. Reserve the id when that lands.
 */
export const RUNNER_COMMAND_IDS = ["clear", "branch"] as const;
export type RunnerCommandId = (typeof RUNNER_COMMAND_IDS)[number];

export const runnerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session-id"), id: z.string() }),
  z.object({ type: z.literal("text"), text: z.string() }),
  // `input`/`output` are arbitrary JSON — z.unknown() is intentional; do not tighten.
  z.object({ type: z.literal("tool-call"), toolId: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("tool-result"), toolId: z.string(), output: z.unknown() }),
  z.object({ type: z.literal("permission-request"), toolId: z.string(), name: z.string(), input: z.unknown() }),
  // `usage` is an open record — token-accounting keys vary per runner;
  // consumers must treat every key as an optional hint.
  z.object({ type: z.literal("done"), usage: z.record(z.number()).optional() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type RunnerEvent = z.infer<typeof runnerEventSchema>;

export interface StartSessionOpts {
  /** Working directory for the runner process. The Runner Host derives this per thread. */
  cwd: string;
  /** SP-4: path to an MCP config JSON (e.g. cogni orchestrator tools). Passed as `--mcp-config`. */
  mcpConfigPath?: string;
  /** SP-4: restrict the runner to these tool names. Passed as `--allowed-tools`. */
  allowedTools?: string[];
  /** SP-4: extra system-prompt text (e.g. orchestrator preamble). Passed as `--append-system-prompt`. */
  appendSystemPrompt?: string;
  /** Chat model id (a CHAT_MODELS id). Passed as `--model <id>`; absent ⇒ CLI default. */
  model?: string;
  /**
   * Branch: when resuming, fork the session instead of continuing it (Claude
   * Code `--fork-session`). The resumed id becomes the parent; the runner
   * assigns a new session id for this fork. Only meaningful on `resumeSession`.
   */
  fork?: boolean;
}

export interface RunnerSessionHandle {
  /** The runner's own session id once known (Claude's `session_id`); null until first event. */
  readonly runnerSessionId: string | null;
  /**
   * True once the underlying runner process has exited and the handle must be
   * discarded (so the next dispatch spawns a fresh one). Adapters that don't
   * hold a persistent process leave this undefined — the handle is never evicted.
   */
  readonly closed?: boolean;
  /** Send one user message; yields events until the turn ends with `done` or `error`. */
  send(message: string): AsyncIterable<RunnerEvent>;
  /**
   * Prewarm the underlying runner process before the first `send`, so its cold
   * start is paid ahead of the user's first message. Optional: adapters that
   * spawn lazily per turn don't implement it.
   */
  warmup?(): Promise<void>;
  /**
   * Stop the in-flight turn (the composer's ↑→■ button). Best-effort and
   * idempotent: the adapter ends the current turn as gracefully as it can
   * (Claude Code sends a stream-json `control_request` interrupt; falling back
   * to killing the process, which the next dispatch `--resume`s). After an
   * interrupt the live `send()` iterator is expected to terminate with a `done`
   * (or `error`) event like any other turn boundary. Adapters that can't
   * interrupt mid-turn omit it; the manager then no-ops.
   */
  interrupt?(): void;
  /** Idempotent; resolves once the underlying runner process has exited. */
  close(): Promise<void>;
}

export interface RunnerAdapter {
  readonly id: string;
  readonly capabilities: readonly RunnerCapability[];
  /**
   * Chat commands this runner exposes in the composer. Declared per-adapter so
   * the cloud aggregates them into the `register` frame and the UI renders the
   * right "/" menu for whichever adapter a thread uses. Empty ⇒ no slash menu.
   */
  readonly commands: readonly RunnerCommandId[];
  startSession(opts: StartSessionOpts): Promise<RunnerSessionHandle>;
  resumeSession(runnerSessionId: string, opts: StartSessionOpts): Promise<RunnerSessionHandle>;
}
