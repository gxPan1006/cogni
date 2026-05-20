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
  /** Idempotent; resolves once the underlying runner process has exited. */
  close(): Promise<void>;
}

export interface RunnerAdapter {
  readonly id: string;
  readonly capabilities: readonly RunnerCapability[];
  startSession(opts: StartSessionOpts): Promise<RunnerSessionHandle>;
  resumeSession(runnerSessionId: string, opts: StartSessionOpts): Promise<RunnerSessionHandle>;
}
