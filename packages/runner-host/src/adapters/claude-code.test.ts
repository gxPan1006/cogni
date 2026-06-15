import { describe, it, expect } from "vitest";
import { ClaudeCodeAdapter, makeClaudeProcessFactory, type ClaudeProcess, type ClaudeProcessFactory } from "./claude-code.js";
import type { RunnerEvent } from "@cogni/contract";

/**
 * Fake process: each `write` (i.e. each turn) replays one batch of canned
 * stream-json lines on the next microtask, mimicking the real per-turn
 * stdout. `spawns` counts how many processes were created so warm-reuse is
 * assertable; `params` captures the spawn args.
 */
function fakeFactory(turns: string[][]) {
  const state = { spawns: 0, params: [] as Array<Parameters<ClaudeProcessFactory>[0]>, written: [] as string[], killed: 0, interrupts: 0 };
  let turnIdx = 0;
  const factory: ClaudeProcessFactory = (p) => {
    state.spawns += 1;
    state.params.push(p);
    const lineCbs: Array<(l: string) => void> = [];
    const exitCbs: Array<(i: { code: number | null; stderr: string }) => void> = [];
    const proc: ClaudeProcess & { emitExit: (i: { code: number | null; stderr: string }) => void } = {
      write: (line) => {
        state.written.push(line);
        const lines = turns[turnIdx] ?? [];
        turnIdx += 1;
        queueMicrotask(() => { for (const l of lines) for (const cb of lineCbs) cb(l); });
      },
      interrupt: () => { state.interrupts += 1; },
      onLine: (cb) => { lineCbs.push(cb); },
      onExit: (cb) => { exitCbs.push(cb); },
      kill: () => { state.killed += 1; },
      emitExit: (i) => { for (const cb of exitCbs) cb(i); },
    };
    return proc;
  };
  return { factory, state };
}

async function collect(it: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

// One streaming-mode turn: system init → text deltas → tool_use block →
// tool_result → result. Mirrors `claude --include-partial-messages` output.
function turnLines(text: string, opts: { withTool?: boolean } = {}): string[] {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "claude-1" }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } }),
  ];
  if (opts.withTool) {
    lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { cmd: "ls" } }] } }));
    lines.push(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "file.txt" }] } }));
  }
  // The trailing full assistant text block must NOT produce a second text event.
  lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }));
  lines.push(JSON.stringify({ type: "result", subtype: "success", session_id: "claude-1", usage: { input_tokens: 10, output_tokens: 5 } }));
  return lines;
}

describe("ClaudeCodeAdapter", () => {
  it("declares its id, capabilities, and composer commands", () => {
    const { factory } = fakeFactory([]);
    const a = new ClaudeCodeAdapter(factory);
    expect(a.id).toBe("claude-code");
    expect(a.capabilities).toEqual(["streaming", "session-resume", "tool-events"]);
    expect(a.commands).toEqual(["clear", "branch"]);
  });
  it("can be registered as the Claude Code snapshot core with the same protocol surface", () => {
    const { factory } = fakeFactory([]);
    const a = new ClaudeCodeAdapter(factory, "claude-code-snapshot");
    expect(a.id).toBe("claude-code-snapshot");
    expect(a.capabilities).toEqual(["streaming", "session-resume", "tool-events"]);
    expect(a.commands).toEqual(["clear", "branch"]);
  });
  it("prefixes custom kernel args before the standard Claude Code stream-json flags", async () => {
    const factory = makeClaudeProcessFactory({
      command: "bash",
      args: ["-lc", 'sleep 0.05; printf "%s\\n" "$0 $*"'],
    });
    const proc = factory({ cwd: "/tmp" });
    const lines: string[] = [];
    const exited = new Promise<void>((resolve) => {
      proc.onExit(() => resolve());
    });
    proc.onLine((line) => lines.push(line));
    await exited;
    expect(lines[0]).toContain("--print --input-format stream-json --output-format stream-json");
  });

  it("interrupt() pokes the live process and the turn-ending error reads as a clean done", async () => {
    // Manual factory: the turn stays open until we feed a result line, so we
    // can interrupt mid-turn deterministically (no fallback timer involved).
    let lineCb: ((l: string) => void) | null = null;
    const written: string[] = [];
    const factory: ClaudeProcessFactory = () => ({
      write: (l) => { written.push(l); },
      interrupt: () => { written.push("__interrupt__"); },
      onLine: (cb) => { lineCb = cb; },
      onExit: () => {},
      kill: () => {},
    });
    const adapter = new ClaudeCodeAdapter(factory);
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    const iter = session.send("hi")[Symbol.asyncIterator]();
    const first = iter.next(); // starts the turn (turnActive = true)
    session.interrupt!();
    expect(written).toContain("__interrupt__");
    // The CLI ends the interrupted turn with an error-coded result; the adapter
    // coerces it to `done` so a user stop never surfaces as a fault.
    queueMicrotask(() => lineCb!(JSON.stringify({ type: "result", subtype: "interrupted", result: "stopped" })));
    expect((await first).value).toEqual({ type: "done" });
  });

  it("interrupt() is a no-op when no turn is in flight", async () => {
    const { factory, state } = fakeFactory([turnLines("ok")]);
    const adapter = new ClaudeCodeAdapter(factory);
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    session.interrupt!(); // before any send → process not even spawned
    await collect(session.send("hi"));
    session.interrupt!(); // after the turn already finished
    expect(state.interrupts).toBe(0);
  });

  it("translates a full streaming turn into RunnerEvents (text from deltas, tools from blocks)", async () => {
    const { factory } = fakeFactory([turnLines("hello", { withTool: true })]);
    const adapter = new ClaudeCodeAdapter(factory);
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    const events = await collect(session.send("hi"));
    expect(events.map((e) => e.type)).toEqual([
      "session-id", "text", "tool-call", "tool-result", "session-id", "done",
    ]);
    expect(events.find((e) => e.type === "text")).toEqual({ type: "text", text: "hello" });
    expect(session.runnerSessionId).toBe("claude-1");
  });

  it("does NOT double-count text from the trailing full assistant block", async () => {
    const { factory } = fakeFactory([turnLines("once")]);
    const adapter = new ClaudeCodeAdapter(factory);
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    const events = await collect(session.send("hi"));
    expect(events.filter((e) => e.type === "text")).toEqual([{ type: "text", text: "once" }]);
  });

  it("reuses one warm process across turns (no re-spawn)", async () => {
    const { factory, state } = fakeFactory([turnLines("turn one"), turnLines("turn two")]);
    const adapter = new ClaudeCodeAdapter(factory);
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    await collect(session.send("first"));
    await collect(session.send("second"));
    expect(state.spawns).toBe(1);
    expect(state.written).toHaveLength(2);
  });

  it("warmup() spawns the process before the first send", async () => {
    const { factory, state } = fakeFactory([turnLines("hi there")]);
    const adapter = new ClaudeCodeAdapter(factory);
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    expect(session.warmup).toBeTypeOf("function");
    await session.warmup!();
    expect(state.spawns).toBe(1);
    expect(state.written).toHaveLength(0); // booted, no turn sent yet
    const events = await collect(session.send("hi"));
    expect(state.spawns).toBe(1); // send reused the warmed process
    expect(events.at(-1)).toEqual({ type: "done", usage: { input_tokens: 10, output_tokens: 5 } });
  });

  it("maps a non-success result subtype to an error event", async () => {
    const { factory } = fakeFactory([[JSON.stringify({ type: "result", subtype: "error_max_turns", result: "too many turns" })]]);
    const adapter = new ClaudeCodeAdapter(factory);
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    const events = await collect(session.send("hi"));
    expect(events).toEqual([{ type: "error", code: "error_max_turns", message: "too many turns" }]);
  });

  it("yields an error and marks closed when the process exits mid-turn", async () => {
    // A factory whose process never emits a result; we trigger exit instead.
    let emitExit: ((i: { code: number | null; stderr: string }) => void) | null = null;
    const factory: ClaudeProcessFactory = () => {
      const exitCbs: Array<(i: { code: number | null; stderr: string }) => void> = [];
      emitExit = (i) => { for (const cb of exitCbs) cb(i); };
      return {
        write: () => {},
        interrupt: () => {},
        onLine: () => {},
        onExit: (cb) => { exitCbs.push(cb); },
        kill: () => {},
      };
    };
    const adapter = new ClaudeCodeAdapter(factory);
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    const iter = session.send("hi")[Symbol.asyncIterator]();
    const nextP = iter.next();
    // process dies before producing a result line
    queueMicrotask(() => emitExit!({ code: 1, stderr: "boom" }));
    const first = await nextP;
    expect(first.value).toEqual({ type: "error", code: "claude_exited", message: "boom" });
    expect(session.closed).toBe(true);
  });

  it("resumeSession seeds runnerSessionId for --resume", async () => {
    const { factory } = fakeFactory([]);
    const adapter = new ClaudeCodeAdapter(factory);
    const session = await adapter.resumeSession("claude-prev", { cwd: "/tmp/x" });
    expect(session.runnerSessionId).toBe("claude-prev");
  });

  it("passes mcpConfigPath + allowedTools through to the process factory", async () => {
    const { factory, state } = fakeFactory([turnLines("ok")]);
    const adapter = new ClaudeCodeAdapter(factory);
    const session = await adapter.startSession({
      cwd: "/tmp",
      mcpConfigPath: "/tmp/cogni-mcp.json",
      allowedTools: ["mcp__cogni__create_task"],
    });
    await collect(session.send("hi"));
    expect(state.params[0]).toMatchObject({
      mcpConfigPath: "/tmp/cogni-mcp.json",
      allowedTools: ["mcp__cogni__create_task"],
    });
  });

  it("passes appendSystemPrompt + model through to the process factory", async () => {
    const { factory, state } = fakeFactory([turnLines("ok")]);
    const adapter = new ClaudeCodeAdapter(factory);
    const session = await adapter.startSession({ cwd: "/tmp", appendSystemPrompt: "你是 Cogni 编排助手", model: "claude-x" });
    await collect(session.send("hi"));
    expect(state.params[0]).toMatchObject({ appendSystemPrompt: "你是 Cogni 编排助手", model: "claude-x" });
  });
});
