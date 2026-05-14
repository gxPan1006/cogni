import { describe, it, expect, vi } from "vitest";
import { RunnerManager } from "./runner-manager.js";
import type { RunnerAdapter, RunnerEvent } from "@cogni/contract";

function fakeAdapter(events: RunnerEvent[]): RunnerAdapter {
  const make = (resumeId: string | null) => ({
    runnerSessionId: resumeId,
    async *send() { for (const e of events) yield e; },
    async close() {},
  });
  return {
    id: "claude-code",
    capabilities: ["streaming"],
    startSession: vi.fn(async () => make(null)),
    resumeSession: vi.fn(async (id: string) => make(id)),
  };
}

describe("RunnerManager", () => {
  it("dispatches to the named adapter and forwards every event", async () => {
    const adapter = fakeAdapter([{ type: "text", text: "hi" }, { type: "done" }]);
    const mgr = new RunnerManager();
    mgr.register(adapter);
    const seen: RunnerEvent[] = [];
    await mgr.dispatch(
      { sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null, message: "go" },
      (e) => seen.push(e),
    );
    expect(seen.map((e) => e.type)).toEqual(["text", "done"]);
    expect(adapter.startSession).toHaveBeenCalledOnce();
  });

  it("uses resumeSession when a runnerSessionId is provided", async () => {
    const adapter = fakeAdapter([{ type: "done" }]);
    const mgr = new RunnerManager();
    mgr.register(adapter);
    await mgr.dispatch(
      { sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: "claude-prev", message: "go" },
      () => {},
    );
    expect(adapter.resumeSession).toHaveBeenCalledWith("claude-prev", expect.objectContaining({ cwd: expect.any(String) }));
  });

  it("emits an error event when the adapter is unknown", async () => {
    const mgr = new RunnerManager();
    const seen: RunnerEvent[] = [];
    await mgr.dispatch(
      { sessionId: "s1", threadId: "t1", adapter: "nope", runnerSessionId: null, message: "go" },
      (e) => seen.push(e),
    );
    expect(seen).toEqual([{ type: "error", code: "unknown_adapter", message: "no adapter registered for 'nope'" }]);
  });

  it("capabilities() returns adapter ids and the deduped union of capabilities", () => {
    const mgr = new RunnerManager();
    mgr.register(fakeAdapter([])); // id "claude-code", capabilities ["streaming"]
    const codex: RunnerAdapter = {
      id: "codex",
      capabilities: ["streaming", "tool-events"],
      startSession: async () => ({ runnerSessionId: null, async *send() {}, async close() {} }),
      resumeSession: async () => ({ runnerSessionId: null, async *send() {}, async close() {} }),
    };
    mgr.register(codex);
    const caps = mgr.capabilities();
    expect(caps.adapters.sort()).toEqual(["claude-code", "codex"]);
    expect(caps.capabilities.sort()).toEqual(["streaming", "tool-events"]);
  });
});
