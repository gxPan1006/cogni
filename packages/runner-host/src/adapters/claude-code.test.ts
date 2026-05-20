import { describe, it, expect } from "vitest";
import { ClaudeCodeAdapter, type ClaudeRunner } from "./claude-code.js";
import type { RunnerEvent } from "@cogni/contract";

// Fake runner: yields canned Claude stream-json lines.
function fakeRunner(lines: string[]) {
  return async function* () {
    for (const l of lines) yield l;
  };
}

async function collect(it: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("ClaudeCodeAdapter", () => {
  it("declares its id and capabilities", () => {
    const a = new ClaudeCodeAdapter(fakeRunner([]));
    expect(a.id).toBe("claude-code");
    expect(a.capabilities).toEqual(["streaming", "session-resume", "tool-events"]);
  });

  it("translates a full stream-json turn into RunnerEvents", async () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { cmd: "ls" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "file.txt" }] } }),
      JSON.stringify({ type: "result", subtype: "success", session_id: "claude-1", usage: { input_tokens: 10, output_tokens: 5 } }),
    ];
    const adapter = new ClaudeCodeAdapter(fakeRunner(lines));
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    const events = await collect(session.send("hi"));
    expect(events.map((e) => e.type)).toEqual([
      "session-id", "text", "tool-call", "tool-result", "session-id", "done",
    ]);
    expect(session.runnerSessionId).toBe("claude-1");
  });

  it("maps a non-success result subtype to an error event", async () => {
    const lines = [JSON.stringify({ type: "result", subtype: "error_max_turns", result: "too many turns" })];
    const adapter = new ClaudeCodeAdapter(fakeRunner(lines));
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    const events = await collect(session.send("hi"));
    expect(events).toEqual([{ type: "error", code: "error_max_turns", message: "too many turns" }]);
  });

  it("synthesizes a done event if the stream ends without a result line", async () => {
    const adapter = new ClaudeCodeAdapter(fakeRunner([JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } })]));
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    const events = await collect(session.send("hi"));
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("resumeSession seeds runnerSessionId for --resume", async () => {
    const adapter = new ClaudeCodeAdapter(fakeRunner([]));
    const session = await adapter.resumeSession("claude-prev", { cwd: "/tmp/x" });
    expect(session.runnerSessionId).toBe("claude-prev");
  });

  it("passes mcpConfigPath + allowedTools through to the runner", async () => {
    const seen: Array<Parameters<ClaudeRunner>[0]> = [];
    const runner: ClaudeRunner = async function* (p) {
      seen.push(p);
      yield JSON.stringify({ type: "result", subtype: "success" });
    };
    const adapter = new ClaudeCodeAdapter(runner);
    const session = await adapter.startSession({
      cwd: "/tmp",
      mcpConfigPath: "/tmp/cogni-mcp.json",
      allowedTools: ["mcp__cogni__create_task"],
    });
    for await (const _ of session.send("hi")) { /* drain */ }
    expect(seen[0]).toMatchObject({
      mcpConfigPath: "/tmp/cogni-mcp.json",
      allowedTools: ["mcp__cogni__create_task"],
    });
  });
});
