import { describe, it, expect } from "vitest";
import { CodexAdapter } from "./index.js";
import { translateCodexLine, CODEX_BASE_ARGS, type CodexRunner } from "./codex-process.js";
import type { RunnerEvent } from "@cogni/contract";

/** Fake runner: yields canned JSONL lines from one "turn". */
function fakeRunner(lines: string[]): CodexRunner {
  return async function* () {
    for (const l of lines) yield l;
  };
}

async function collect(it: AsyncIterable<RunnerEvent>): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("CodexAdapter — capability surface", () => {
  it("declares id='codex' and the streaming + tool-events capabilities only", () => {
    const adapter = new CodexAdapter(fakeRunner([]));
    expect(adapter.id).toBe("codex");
    expect(adapter.capabilities).toEqual(["streaming", "tool-events"]);
  });

  it("does NOT declare session-resume or permission-prompt (SP-3 §八 contract)", () => {
    const adapter = new CodexAdapter(fakeRunner([]));
    expect(adapter.capabilities).not.toContain("session-resume");
    expect(adapter.capabilities).not.toContain("permission-prompt");
  });
});

describe("CodexAdapter — resumeSession", () => {
  it("rejects immediately — Codex retry path is cold-start", async () => {
    const adapter = new CodexAdapter(fakeRunner([]));
    // The contract method takes (runnerSessionId, opts) but our override has
    // no parameters; whatever you pass, it must reject.
    await expect(adapter.resumeSession("codex-prev", { cwd: "/tmp/x" })).rejects.toThrow(
      /does not support resume/i,
    );
  });
});

describe("CodexAdapter — startSession streams a turn", () => {
  it("translates a thread→tool→message→done turn into RunnerEvents", async () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "codex-sess-1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item_0",
          type: "command_execution",
          command: "/bin/zsh -lc 'echo hi'",
          aggregated_output: "",
          exit_code: null,
          status: "in_progress",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_0",
          type: "command_execution",
          command: "/bin/zsh -lc 'echo hi'",
          aggregated_output: "hi\n",
          exit_code: 0,
          status: "completed",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "All done." },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 1234, output_tokens: 56 },
      }),
    ];
    const adapter = new CodexAdapter(fakeRunner(lines));
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    const events = await collect(session.send("do work"));
    expect(events.map((e) => e.type)).toEqual([
      "session-id",
      "tool-call",
      "tool-result",
      "text",
      "done",
    ]);
    expect(session.runnerSessionId).toBe("codex-sess-1");
  });

  it("maps a process.error line to a single terminal error event", async () => {
    const adapter = new CodexAdapter(
      fakeRunner([
        JSON.stringify({ type: "process.error", exit_code: 1, stderr: "boom" }),
      ]),
    );
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    const events = await collect(session.send("hi"));
    expect(events).toEqual([
      { type: "error", code: "codex_process_error", message: "boom" },
    ]);
  });

  it("synthesises a done event if the stream ends without turn.completed", async () => {
    const adapter = new CodexAdapter(
      fakeRunner([
        JSON.stringify({
          type: "item.completed",
          item: { id: "x", type: "agent_message", text: "partial" },
        }),
      ]),
    );
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    const events = await collect(session.send("hi"));
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("ignores unrecognised JSONL events (forwards-compat)", async () => {
    const adapter = new CodexAdapter(
      fakeRunner([
        JSON.stringify({ type: "thread.started", thread_id: "codex-fwd-1" }),
        JSON.stringify({ type: "future.event.we.dont.know.about", payload: "xx" }),
        JSON.stringify({ type: "turn.completed", usage: { output_tokens: 1 } }),
      ]),
    );
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    const events = await collect(session.send("hi"));
    expect(events.map((e) => e.type)).toEqual(["session-id", "done"]);
  });

  it("ignores non-JSON lines (codex prints status banners on stdout)", async () => {
    const adapter = new CodexAdapter(
      fakeRunner([
        "Reading additional input from stdin...",
        JSON.stringify({ type: "thread.started", thread_id: "codex-banner-1" }),
        JSON.stringify({ type: "turn.completed" }),
      ]),
    );
    const session = await adapter.startSession({ cwd: "/tmp/x" });
    const events = await collect(session.send("hi"));
    expect(events.map((e) => e.type)).toEqual(["session-id", "done"]);
  });
});

describe("CodexAdapter — spawn args (no real codex run)", () => {
  it("CODEX_BASE_ARGS contains --sandbox danger-full-access and --json", () => {
    expect(CODEX_BASE_ARGS).toContain("exec");
    expect(CODEX_BASE_ARGS).toContain("--json");
    const sandboxIdx = CODEX_BASE_ARGS.indexOf("--sandbox");
    expect(sandboxIdx).toBeGreaterThanOrEqual(0);
    expect(CODEX_BASE_ARGS[sandboxIdx + 1]).toBe("danger-full-access");
  });

  it("CODEX_BASE_ARGS contains --skip-git-repo-check so codex runs in fresh worktrees", () => {
    expect(CODEX_BASE_ARGS).toContain("--skip-git-repo-check");
  });
});

describe("translateCodexLine — unit", () => {
  it("returns [] for empty / non-JSON / null inputs", () => {
    expect(translateCodexLine("")).toEqual([]);
    expect(translateCodexLine("not json")).toEqual([]);
    expect(translateCodexLine("null")).toEqual([]);
  });

  it("requires thread_id to be a string for session-id emission", () => {
    expect(translateCodexLine(JSON.stringify({ type: "thread.started" }))).toEqual([]);
    expect(
      translateCodexLine(JSON.stringify({ type: "thread.started", thread_id: "x" })),
    ).toEqual([{ type: "session-id", id: "x" }]);
  });
});
