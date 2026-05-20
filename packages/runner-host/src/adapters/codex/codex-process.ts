/**
 * SP-3 Codex CLI process wrapper.
 *
 * Spawns `codex exec --json ...` per turn, reads JSONL events from stdout,
 * and translates them into the runner-host `RunnerEvent` schema. Mirrors the
 * structure of `adapters/claude-code.ts` so the WS layer can treat Claude
 * Code and Codex interchangeably.
 *
 * One-turn-per-spawn model (no `--resume` integration here):
 *   - SP-3 §八 explicitly decides Codex retry = cold-start a new process.
 *   - The CodexAdapter (index.ts) wraps each spawn in a `RunnerSessionHandle`
 *     whose `send()` invokes `runCodex` for each turn (same as Claude Code).
 *
 * JSONL event mapping (codex → RunnerEvent):
 *   thread.started      → session-id
 *   turn.started        → (no event; UI doesn't need this)
 *   item.started        → tool-call    (when item.type=command_execution)
 *   item.completed      → tool-result  (when item.type=command_execution)
 *                         OR text      (when item.type=agent_message)
 *   turn.completed      → done (carrying usage)
 *   process exit ≠ 0    → error (synthesised from stderr + exitCode)
 *
 * Unrecognised lines are skipped silently; a future Codex CLI may add event
 * types we don't translate yet, and we'd rather pass them through than
 * tear down the session.
 */

import * as readline from "node:readline";
import { execa, type ResultPromise } from "execa";
import type { RunnerEvent } from "@cogni/contract";

/** Injection seam for tests. Yields raw stdout JSONL lines from one codex turn. */
export type CodexRunner = (params: {
  cwd: string;
  message: string;
}) => AsyncIterable<string>;

/** Args we always pass to `codex exec` for cogni-managed sessions. */
export const CODEX_BASE_ARGS = [
  "exec",
  "--json",
  // SP-3 §八: project tasks run unattended on a host the user controls.
  // This is the Codex CLI AFK switch: no approval prompts, no command
  // sandbox. Capability "permission-prompt" is intentionally not declared.
  "--dangerously-bypass-approvals-and-sandbox",
  // The runner-host may dispatch a Codex session into a fresh worktree
  // before any commit lands. `--skip-git-repo-check` keeps codex from
  // refusing to run there.
  "--skip-git-repo-check",
];

/**
 * Default runner — spawns `codex exec --json ...` and streams stdout lines.
 * Mirrors `defaultClaudeRunner`'s `buffer: { stdout: false }` trick so we can
 * drive a `readline` interface while still buffering stderr for the
 * error-on-nonzero-exit code path.
 */
export const defaultCodexRunner: CodexRunner = async function* ({ cwd, message }) {
  // Codex reads the prompt either from argv or stdin. We pass via `input`
  // (stdin) — long messages on argv are awkward across shells and Codex
  // documents that the stdin path is supported.
  const proc = execa("codex", [...CODEX_BASE_ARGS, "-C", cwd], {
    cwd,
    input: message,
    reject: false,
    buffer: { stdout: false },
  });
  if (!proc.stdout) throw new Error("codex stdout unavailable");
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.trim() !== "") yield line;
    }
    const result = await proc;
    if (result.exitCode != null && result.exitCode !== 0) {
      // Synthesise a terminal error frame so the translator emits one
      // `error` event. Reusing JSONL keeps the translator's surface flat.
      yield JSON.stringify({
        type: "process.error",
        exit_code: result.exitCode,
        stderr: result.stderr || `codex exited ${result.exitCode}`,
      });
    }
  } finally {
    // Match claude-code's defensive cleanup: if a consumer stops iterating
    // early (caller cancelled, dispatcher tore down), don't leak the child
    // or readline.
    rl.close();
    (proc as ResultPromise).kill();
  }
};

/** Translate one Codex JSONL line into zero or more RunnerEvents. */
export function translateCodexLine(line: string): RunnerEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Codex occasionally prints a leading status line ("Reading additional
    // input from stdin...") on stdout — non-JSON, ignore.
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const p = parsed as Record<string, unknown>;

  switch (p["type"]) {
    case "thread.started": {
      const id = p["thread_id"];
      return typeof id === "string" ? [{ type: "session-id", id }] : [];
    }
    case "item.started": {
      const item = p["item"];
      if (!item || typeof item !== "object") return [];
      const it = item as Record<string, unknown>;
      // Only `command_execution` items map to tool-calls in our schema.
      // `agent_message` items arrive complete via `item.completed`; their
      // `started` event has no useful content for the UI.
      if (it["type"] !== "command_execution") return [];
      const toolId = String(it["id"] ?? "");
      const command = it["command"];
      return [{
        type: "tool-call",
        toolId,
        name: "shell",
        input: command !== undefined ? { command } : {},
      }];
    }
    case "item.completed": {
      const item = p["item"];
      if (!item || typeof item !== "object") return [];
      const it = item as Record<string, unknown>;
      if (it["type"] === "command_execution") {
        const toolId = String(it["id"] ?? "");
        const output = {
          aggregatedOutput: it["aggregated_output"],
          exitCode: it["exit_code"],
          status: it["status"],
        };
        return [{ type: "tool-result", toolId, output }];
      }
      if (it["type"] === "agent_message") {
        const text = it["text"];
        return typeof text === "string" ? [{ type: "text", text }] : [];
      }
      return [];
    }
    case "turn.completed": {
      return [{ type: "done", usage: numericUsage(p["usage"]) }];
    }
    case "process.error": {
      const message = String(p["stderr"] ?? `codex exited ${p["exit_code"] ?? "?"}`);
      return [{ type: "error", code: "codex_process_error", message }];
    }
    default:
      // Unknown event types (turn.started, future additions) are intentionally
      // dropped. A `runner-warning` event would be nice but is not in the
      // contract's RunnerEvent union.
      return [];
  }
}

function numericUsage(usage: unknown): Record<string, number> | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(usage)) if (typeof v === "number") out[k] = v;
  return Object.keys(out).length ? out : undefined;
}
