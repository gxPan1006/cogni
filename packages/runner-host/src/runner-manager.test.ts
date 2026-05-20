import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerManager } from "./runner-manager.js";
import type { RunnerAdapter, RunnerEvent, RunnerSessionHandle } from "@cogni/contract";

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

  it("orchestrator dispatch injects mcpConfigPath + cogni allowedTools", async () => {
    const seen: any[] = [];
    const adapter: RunnerAdapter = {
      id: "claude-code",
      capabilities: ["streaming"],
      startSession: async (opts: any) => {
        seen.push(opts);
        return { runnerSessionId: null, async *send() {}, async close() {} };
      },
      resumeSession: async (_id: string, opts: any) => {
        seen.push(opts);
        return { runnerSessionId: null, async *send() {}, async close() {} };
      },
    };
    const mgr = new RunnerManager();
    mgr.register(adapter);
    await mgr.dispatch(
      { sessionId: "s", threadId: "th", adapter: "claude-code", runnerSessionId: null, message: "hi", orchestrator: true },
      () => {},
    );
    expect(seen[0].mcpConfigPath).toMatch(/cogni-mcp\.json$/);
    expect(seen[0].allowedTools).toContain("mcp__cogni__create_task");
  });

  it("non-orchestrator dispatch leaves mcp opts unset", async () => {
    const seen: any[] = [];
    const adapter: RunnerAdapter = {
      id: "claude-code",
      capabilities: ["streaming"],
      startSession: async (opts: any) => {
        seen.push(opts);
        return { runnerSessionId: null, async *send() {}, async close() {} };
      },
      resumeSession: async (_id: string, opts: any) => {
        seen.push(opts);
        return { runnerSessionId: null, async *send() {}, async close() {} };
      },
    };
    const mgr = new RunnerManager();
    mgr.register(adapter);
    await mgr.dispatch(
      { sessionId: "s2", threadId: "th2", adapter: "claude-code", runnerSessionId: null, message: "hi" },
      () => {},
    );
    expect(seen[0].mcpConfigPath).toBeUndefined();
    expect(seen[0].allowedTools).toBeUndefined();
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

function attachmentAdapter(): RunnerAdapter {
  const handle: RunnerSessionHandle = {
    runnerSessionId: null,
    async *send() { yield { type: "done" } as const; },
    async close() {},
  };
  return {
    id: "claude-code",
    capabilities: ["streaming"],
    async startSession() { return handle; },
    async resumeSession() { return handle; },
  } as unknown as RunnerAdapter;
}

describe("RunnerManager attachment materialization", () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "cogni-rm-")); process.env.COGNI_HOME = home; });
  afterEach(async () => { delete process.env.COGNI_HOME; await rm(home, { recursive: true, force: true }); });

  it("copies staged attachments into <cwd>/.cogni-uploads before the turn", async () => {
    const stage = join(home, "uploads", "t1");
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, "foo.txt"), "hi");

    const mgr = new RunnerManager();
    mgr.register(attachmentAdapter());
    const events: unknown[] = [];
    await mgr.dispatch(
      { sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null, message: "go", attachments: [{ name: "foo.txt" }] },
      (e) => events.push(e),
    );
    const cwd = join(home, "threads", "t1");
    expect(await readFile(join(cwd, ".cogni-uploads", "foo.txt"), "utf8")).toBe("hi");
  });
});
