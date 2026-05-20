import * as readline from "node:readline";
import { execa } from "execa";
import type {
  RunnerAdapter, RunnerCapability, RunnerEvent, RunnerSessionHandle, StartSessionOpts,
} from "@cogni/contract";

/**
 * A long-lived `claude` process running in **streaming-input mode**
 * (`--input-format stream-json`). The process boots ONCE; each turn writes one
 * NDJSON user message to stdin and reads the turn's stream-json lines back —
 * so turns after the first skip the ~1.9s CLI cold start entirely (measured:
 * turn 2 first-token ~2s vs turn 1 ~4.5s on the same process). Injectable so
 * the session's turn-routing + line translation are unit-tested without
 * spawning a real process.
 */
export interface ClaudeProcess {
  /** Write one NDJSON line (a stream-json user message) to the process stdin. */
  write(line: string): void;
  /** Register a callback for each non-empty stdout line. */
  onLine(cb: (line: string) => void): void;
  /** Register a callback fired once when the process exits. */
  onExit(cb: (info: { code: number | null; stderr: string }) => void): void;
  /** Kill the process. Idempotent. */
  kill(): void;
}

/** Spawn params for one `claude` process. */
export type ClaudeProcessFactory = (params: {
  cwd: string;
  resumeId: string | null;
  appendSystemPrompt?: string;
  mcpConfigPath?: string;
  allowedTools?: string[];
  model?: string;
}) => ClaudeProcess;

const CAPABILITIES: RunnerCapability[] = ["streaming", "session-resume", "tool-events"];

/**
 * Default process: spawns `claude --print --input-format stream-json
 * --output-format stream-json --include-partial-messages --verbose
 * --permission-mode bypassPermissions --dangerously-skip-permissions` and keeps
 * stdin open across turns.
 *
 * **`--input-format stream-json` is what makes the process warm/long-lived.**
 * Instead of one `claude --print` per turn (each paying the full CLI cold
 * start), one process handles every turn of a session: write a user-message
 * JSON line to feed a turn, read until that turn's `result` line, leave the
 * process running for the next turn.
 *
 * **`--include-partial-messages`** makes assistant text arrive as
 * `content_block_delta` chunks (token-ish granularity) instead of one whole
 * message block at the end — so the client renders progressively rather than
 * waiting for the full reply.
 *
 * **`--permission-mode bypassPermissions` + `--dangerously-skip-permissions`
 * are load-bearing (spec §九).** Without them, Claude Code falls into *plan
 * mode* — it writes a plan doc and calls ExitPlanMode instead of editing files,
 * so a task "completes" with an empty worktree. SP-3 trusts the per-task git
 * worktree as the sandbox, so the runner runs unattended with permissions
 * fully bypassed and never pauses for an approval prompt no human is watching.
 *
 * execa v9 note: `buffer: { stdout: false }` keeps stdout an unbuffered
 * Readable we drive with `readline`; stderr stays buffered so a non-zero exit
 * can report a useful message. stdin stays a pipe we write turns into.
 */
export const defaultClaudeProcessFactory: ClaudeProcessFactory = ({ cwd, resumeId, appendSystemPrompt, mcpConfigPath, allowedTools, model }) => {
  const args = [
    "--print",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    // Run unattended: never enter plan mode, never block on an approval prompt.
    "--permission-mode", "bypassPermissions",
    "--dangerously-skip-permissions",
  ];
  if (model) args.push("--model", model);
  // `--resume` is only used to reattach a session after a host/process restart
  // (the cache miss path). Within a live process, turns continue natively.
  if (resumeId) args.push("--resume", resumeId);
  // SP-4: orchestrator dispatches mount the cogni stdio MCP server and restrict
  // the runner to its tools. Claude Code takes one comma-joined `--allowed-tools`.
  if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
  if (allowedTools && allowedTools.length) args.push("--allowed-tools", allowedTools.join(","));

  const proc = execa("claude", args, {
    cwd,
    reject: false,
    stdin: "pipe",
    buffer: { stdout: false },
  });

  const lineCbs: Array<(l: string) => void> = [];
  const exitCbs: Array<(i: { code: number | null; stderr: string }) => void> = [];
  if (proc.stdout) {
    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (line.trim() !== "") for (const cb of lineCbs) cb(line);
    });
  }
  void proc.then(
    (result) => { for (const cb of exitCbs) cb({ code: result.exitCode ?? null, stderr: result.stderr ?? "" }); },
    (err) => { for (const cb of exitCbs) cb({ code: null, stderr: String(err) }); },
  );

  return {
    write: (line) => { proc.stdin?.write(line); },
    onLine: (cb) => { lineCbs.push(cb); },
    onExit: (cb) => { exitCbs.push(cb); },
    kill: () => { proc.kill(); },
  };
};

class ClaudeCodeSession implements RunnerSessionHandle {
  private _runnerSessionId: string | null;
  private proc: ClaudeProcess | null = null;
  private _closed = false;
  private exitInfo: { code: number | null; stderr: string } | null = null;
  // Single-consumer line queue: the manager serializes sends per session, so at
  // most one `send()` reads at a time. Lines that arrive between turns (e.g.
  // SessionStart hook output during warmup) buffer here and are drained — and
  // ignored — at the start of the next turn.
  private buffer: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;

  constructor(
    private readonly factory: ClaudeProcessFactory,
    private readonly cwd: string,
    resumeId: string | null,
    private readonly opts: { appendSystemPrompt?: string; mcpConfigPath?: string; allowedTools?: string[]; model?: string } = {},
  ) {
    this._runnerSessionId = resumeId;
  }

  get runnerSessionId(): string | null {
    return this._runnerSessionId;
  }

  /** True once the underlying process has exited — the manager evicts the handle. */
  get closed(): boolean {
    return this._closed;
  }

  private ensureProc(): void {
    if (this.proc) return;
    this.proc = this.factory({
      cwd: this.cwd,
      resumeId: this._runnerSessionId,
      appendSystemPrompt: this.opts.appendSystemPrompt,
      mcpConfigPath: this.opts.mcpConfigPath,
      allowedTools: this.opts.allowedTools,
      model: this.opts.model,
    });
    this.proc.onLine((l) => this.deliver(l));
    this.proc.onExit((info) => {
      this.exitInfo = info;
      this._closed = true;
      this.deliver(null);
    });
  }

  private deliver(line: string | null): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(line);
    } else if (line !== null) {
      this.buffer.push(line);
    }
  }

  private nextLine(): Promise<string | null> {
    const queued = this.buffer.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this._closed) return Promise.resolve(null);
    return new Promise((res) => { this.waiter = res; });
  }

  /**
   * Prewarm: spawn the process now so the CLI cold start (and SessionStart
   * hooks) are paid before the first user message. No-op if already started.
   */
  async warmup(): Promise<void> {
    this.ensureProc();
  }

  async *send(message: string): AsyncIterable<RunnerEvent> {
    this.ensureProc();
    if (this._closed) {
      yield { type: "error", code: "claude_exited", message: this.exitInfo?.stderr || "claude process exited" };
      return;
    }
    this.proc!.write(
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: message }] } }) + "\n",
    );
    while (true) {
      const line = await this.nextLine();
      if (line === null) {
        // Process exited before this turn produced a terminal `result`.
        yield { type: "error", code: "claude_exited", message: this.exitInfo?.stderr || "claude process exited" };
        return;
      }
      for (const event of translateLine(line)) {
        if (event.type === "session-id") this._runnerSessionId = event.id;
        if (event.type === "done" || event.type === "error") {
          yield event;
          return; // turn boundary — leave the process running for the next turn
        }
        yield event;
      }
    }
  }

  async close(): Promise<void> {
    this._closed = true;
    this.proc?.kill();
    this.proc = null;
  }
}

export class ClaudeCodeAdapter implements RunnerAdapter {
  readonly id = "claude-code";
  readonly capabilities = CAPABILITIES;
  constructor(private readonly factory: ClaudeProcessFactory = defaultClaudeProcessFactory) {}

  async startSession(opts: StartSessionOpts): Promise<RunnerSessionHandle> {
    return new ClaudeCodeSession(this.factory, opts.cwd, null, {
      appendSystemPrompt: opts.appendSystemPrompt,
      mcpConfigPath: opts.mcpConfigPath,
      allowedTools: opts.allowedTools,
      model: opts.model,
    });
  }
  async resumeSession(runnerSessionId: string, opts: StartSessionOpts): Promise<RunnerSessionHandle> {
    return new ClaudeCodeSession(this.factory, opts.cwd, runnerSessionId, {
      appendSystemPrompt: opts.appendSystemPrompt,
      mcpConfigPath: opts.mcpConfigPath,
      allowedTools: opts.allowedTools,
      model: opts.model,
    });
  }
}

/** Translate one Claude stream-json line into zero or more RunnerEvents. */
function translateLine(line: string): RunnerEvent[] {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];

  switch (parsed.type) {
    case "system":
      return typeof parsed.session_id === "string" ? [{ type: "session-id", id: parsed.session_id }] : [];
    case "stream_event": {
      // Partial-message deltas: assistant text streams token-ish-by-token here,
      // so the client renders progressively. Text is taken ONLY from these
      // deltas; the trailing full `assistant` block (below) repeats the same
      // text and would double-count, so its text is skipped there.
      const ev = parsed.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        return ev.delta.text ? [{ type: "text", text: ev.delta.text }] : [];
      }
      return [];
    }
    case "assistant": {
      // Text already streamed via `stream_event` deltas — emit only tool calls
      // here. The full block carries the COMPLETE tool-call input (unlike the
      // partial `input_json_delta` stream), so it's the right place for them.
      const blocks = parsed.message?.content;
      if (!Array.isArray(blocks)) return [];
      const out: RunnerEvent[] = [];
      for (const b of blocks) {
        if (b?.type === "tool_use") {
          out.push({ type: "tool-call", toolId: String(b.id ?? ""), name: String(b.name ?? ""), input: b.input });
        }
      }
      return out;
    }
    case "user": {
      const blocks = parsed.message?.content;
      if (!Array.isArray(blocks)) return [];
      const out: RunnerEvent[] = [];
      for (const b of blocks) {
        if (b?.type === "tool_result") {
          out.push({ type: "tool-result", toolId: String(b.tool_use_id ?? ""), output: b.content });
        }
      }
      return out;
    }
    case "result": {
      const out: RunnerEvent[] = [];
      if (typeof parsed.session_id === "string") out.push({ type: "session-id", id: parsed.session_id });
      if (parsed.subtype && parsed.subtype !== "success") {
        out.push({ type: "error", code: String(parsed.subtype), message: String(parsed.result ?? parsed.subtype) });
      } else {
        out.push({ type: "done", usage: numericUsage(parsed.usage) });
      }
      return out;
    }
    default:
      return [];
  }
}

function numericUsage(usage: unknown): Record<string, number> | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(usage)) if (typeof v === "number") out[k] = v;
  return Object.keys(out).length ? out : undefined;
}
