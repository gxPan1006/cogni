import { describe, it, expect } from "vitest";
import { handleDispatch } from "./registry.js";
import { RunnerManager } from "./runner-manager.js";
import type { RunnerAdapter } from "@cogni/contract";

function fakeAdapter(): RunnerAdapter {
  return {
    id: "claude-code",
    capabilities: ["streaming"],
    async startSession() {
      return {
        runnerSessionId: null,
        async *send() {
          yield { type: "session-id", id: "claude-1" } as const;
          yield { type: "text", text: "hi" } as const;
          yield { type: "done" } as const;
        },
        async close() {},
      };
    },
    async resumeSession() {
      throw new Error("unused");
    },
  };
}

describe("handleDispatch", () => {
  it("forwards each RunnerEvent as an `event` message then a `session-update` completed", async () => {
    const mgr = new RunnerManager();
    mgr.register(fakeAdapter());
    const sent: any[] = [];
    await handleDispatch(
      mgr,
      {
        t: "dispatch",
        sessionId: "s1",
        threadId: "t1",
        adapter: "claude-code",
        runnerSessionId: null,
        message: "go",
      },
      (m) => sent.push(m),
    );
    expect(sent.map((m) => `${m.t}:${m.event?.type ?? m.status ?? ""}`)).toEqual([
      "event:session-id",
      "event:text",
      "event:done",
      "session-update:completed",
    ]);
  });

  it("forwards the orchestrator flag from the dispatch frame into the manager", async () => {
    const seen: any[] = [];
    const adapter: RunnerAdapter = {
      id: "claude-code",
      capabilities: ["streaming"],
      async startSession(opts: any) {
        seen.push(opts);
        return { runnerSessionId: null, async *send() {}, async close() {} };
      },
      async resumeSession() {
        throw new Error("unused");
      },
    };
    const mgr = new RunnerManager();
    mgr.register(adapter);
    await handleDispatch(
      mgr,
      {
        t: "dispatch",
        sessionId: "s1",
        threadId: "t1",
        adapter: "claude-code",
        runnerSessionId: null,
        message: "go",
        orchestrator: true,
      },
      () => {},
    );
    expect(seen[0].mcpConfigPath).toMatch(/cogni-mcp\.json$/);
    expect(seen[0].allowedTools).toContain("mcp__cogni__create_task");
  });

  it("reports session-update failed when an error event occurs", async () => {
    const mgr = new RunnerManager(); // no adapters → unknown_adapter error
    const sent: any[] = [];
    await handleDispatch(
      mgr,
      {
        t: "dispatch",
        sessionId: "s1",
        threadId: "t1",
        adapter: "x",
        runnerSessionId: null,
        message: "go",
      },
      (m) => sent.push(m),
    );
    expect(sent.at(-1)).toEqual({ t: "session-update", sessionId: "s1", status: "failed" });
  });
});
