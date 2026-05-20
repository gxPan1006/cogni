import * as readline from "node:readline";
import { execa } from "execa";
import type {
  RunnerAdapter, RunnerCapability, RunnerEvent, RunnerSessionHandle, StartSessionOpts,
} from "@cogni/contract";

/** Yields raw stdout lines from a `claude` turn. Injectable so translation is unit-tested. */
export type ClaudeRunner = (params: {
  cwd: string;
  message: string;
  resumeId: string | null;
  /** SP-4: path to an MCP config JSON passed as `--mcp-config`. */
  appendSystemPrompt?: string;
  mcpConfigPath?: string;
  /** SP-4: tool allowlist passed as a single comma-joined `--allowed-tools`. */
  allowedTools?: string[];
}) => AsyncIterable<string>;

const CAPABILITIES: RunnerCapability[] = ["streaming", "session-resume", "tool-events"];

/**
 * Default runner: spawns `claude --print --output-format stream-json --verbose
 * --permission-mode bypassPermissions --dangerously-skip-permissions`, pipes
 * the message on stdin, yields stdout lines.
 *
 * **`--permission-mode bypassPermissions` + `--dangerously-skip-permissions`
 * are load-bearing (spec §九).** Without them, Claude Code falls into *plan
 * mode* — it writes a plan doc to ~/.claude/plans and calls ExitPlanMode
 * instead of editing files in the worktree, so the task "completes" with an
 * empty worktree and no commit. SP-3 deliberately trusts the per-task git
 * worktree as the sandbox, so the runner runs unattended with permissions
 * fully bypassed and never pauses for an approval prompt that no human is
 * watching.
 *
 * execa v9 note: `buffer: false` would unset `proc.stdout` (no stream) and
 * `result.stderr`. We instead use the per-fd form `buffer: { stdout: false }`:
 * stdout stays an unbuffered Readable we can drive with `readline`, while stderr
 * is still buffered so a non-zero exit can report a useful message.
 */
export const defaultClaudeRunner: ClaudeRunner = async function* ({ cwd, message, resumeId, appendSystemPrompt, mcpConfigPath, allowedTools }) {
  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    // Run unattended: never enter plan mode, never block on an approval prompt.
    "--permission-mode", "bypassPermissions",
    "--dangerously-skip-permissions",
  ];
  if (resumeId) args.push("--resume", resumeId);
  // SP-4: orchestrator dispatches mount the cogni stdio MCP server and
  // restrict the runner to its tools. Claude Code takes one comma-joined
  // `--allowed-tools` argument.
  if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
  if (allowedTools && allowedTools.length) args.push("--allowed-tools", allowedTools.join(","));
  const proc = execa("claude", args, {
    cwd,
    input: message,
    reject: false,
    buffer: { stdout: false },
  });
  if (!proc.stdout) throw new Error("claude stdout unavailable");
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.trim() !== "") yield line;
    }
    const result = await proc;
    if (result.exitCode != null && result.exitCode !== 0) {
      yield JSON.stringify({
        type: "result",
        subtype: "process_error",
        result: result.stderr || `claude exited ${result.exitCode}`,
      });
    }
  } finally {
    // If the consumer stops iterating early, don't leak the readline
    // interface or the `claude` child process. (No-op if already finished.)
    rl.close();
    proc.kill();
  }
};

class ClaudeCodeSession implements RunnerSessionHandle {
  private _runnerSessionId: string | null;
  constructor(
    private readonly runner: ClaudeRunner,
    private readonly cwd: string,
    resumeId: string | null,
    private readonly opts: { appendSystemPrompt?: string; mcpConfigPath?: string; allowedTools?: string[] } = {},
  ) {
    this._runnerSessionId = resumeId;
  }
  get runnerSessionId(): string | null {
    return this._runnerSessionId;
  }
  async *send(message: string): AsyncIterable<RunnerEvent> {
    let sawTerminal = false;
    try {
      for await (const line of this.runner({
        cwd: this.cwd,
        message,
        resumeId: this._runnerSessionId,
        appendSystemPrompt: this.opts.appendSystemPrompt,
        mcpConfigPath: this.opts.mcpConfigPath,
        allowedTools: this.opts.allowedTools,
      })) {
        for (const event of translateLine(line)) {
          if (event.type === "session-id") this._runnerSessionId = event.id;
          if (event.type === "done" || event.type === "error") sawTerminal = true;
          yield event;
        }
      }
    } catch (e) {
      yield { type: "error", code: "claude_spawn_failed", message: String(e) };
      return;
    }
    if (!sawTerminal) yield { type: "done" };
  }
  async close(): Promise<void> {
    // No persistent process: each turn is a fresh `claude --print` invocation.
  }
}

export class ClaudeCodeAdapter implements RunnerAdapter {
  readonly id = "claude-code";
  readonly capabilities = CAPABILITIES;
  constructor(private readonly runner: ClaudeRunner = defaultClaudeRunner) {}

  async startSession(opts: StartSessionOpts): Promise<RunnerSessionHandle> {
    return new ClaudeCodeSession(this.runner, opts.cwd, null, {
      appendSystemPrompt: opts.appendSystemPrompt,
      mcpConfigPath: opts.mcpConfigPath,
      allowedTools: opts.allowedTools,
    });
  }
  async resumeSession(runnerSessionId: string, opts: StartSessionOpts): Promise<RunnerSessionHandle> {
    return new ClaudeCodeSession(this.runner, opts.cwd, runnerSessionId, {
      appendSystemPrompt: opts.appendSystemPrompt,
      mcpConfigPath: opts.mcpConfigPath,
      allowedTools: opts.allowedTools,
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
    case "assistant": {
      const blocks = parsed.message?.content;
      if (!Array.isArray(blocks)) return [];
      const out: RunnerEvent[] = [];
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string") {
          out.push({ type: "text", text: b.text });
        } else if (b?.type === "tool_use") {
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
