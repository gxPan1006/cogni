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
    capabilities: ["streaming", "session-resume"],
    commands: ["clear", "branch"],
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

  it("cold-starts adapters without session-resume even when runnerSessionId is present", async () => {
    const adapter = fakeAdapter([{ type: "done" }]);
    Object.defineProperty(adapter, "id", { value: "codex" });
    Object.defineProperty(adapter, "capabilities", { value: ["streaming"] });
    const mgr = new RunnerManager();
    mgr.register(adapter);

    await mgr.dispatch(
      { sessionId: "s1", threadId: "t1", adapter: "codex", runnerSessionId: "codex-prev", message: "go" },
      () => {},
    );

    expect(adapter.startSession).toHaveBeenCalledOnce();
    expect(adapter.resumeSession).not.toHaveBeenCalled();
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
    mgr.register(fakeAdapter([])); // id "claude-code", capabilities ["streaming", "session-resume"]
    const codex: RunnerAdapter = {
      id: "codex",
      capabilities: ["streaming", "tool-events"],
      commands: ["clear"],
      startSession: async () => ({ runnerSessionId: null, async *send() {}, async close() {} }),
      resumeSession: async () => ({ runnerSessionId: null, async *send() {}, async close() {} }),
    };
    mgr.register(codex);
    const snapshot: RunnerAdapter = {
      id: "claude-code-snapshot",
      capabilities: ["streaming", "session-resume", "tool-events"],
      commands: ["clear", "branch"],
      startSession: async () => ({ runnerSessionId: null, async *send() {}, async close() {} }),
      resumeSession: async () => ({ runnerSessionId: null, async *send() {}, async close() {} }),
    };
    mgr.register(snapshot);
    const caps = mgr.capabilities();
    expect(caps.adapters.sort()).toEqual(["claude-code", "claude-code-snapshot", "codex"]);
    expect(caps.capabilities.sort()).toEqual(["session-resume", "streaming", "tool-events"]);
    // Per-adapter commands are surfaced separately (the composer "/" menu).
    expect(caps.adapterCommands).toEqual({
      "claude-code": ["clear", "branch"],
      "claude-code-snapshot": ["clear", "branch"],
      codex: ["clear"],
    });
  });

  it("interrupt() pokes the live session handle's interrupt and is a no-op for unknown sessions", async () => {
    const mgr = new RunnerManager();
    let interrupts = 0;
    const adapter: RunnerAdapter = {
      id: "claude-code",
      capabilities: ["streaming"],
      commands: [],
      startSession: async () => ({
        runnerSessionId: null,
        async *send() { yield { type: "text", text: "hi" } as const; yield { type: "done" } as const; },
        interrupt() { interrupts += 1; },
        async close() {},
      }),
      resumeSession: async () => { throw new Error("unused"); },
    };
    mgr.register(adapter);
    expect(() => mgr.interrupt("no-such-session")).not.toThrow(); // no live handle
    // Run a turn so a handle is cached, then interrupt that session.
    await mgr.dispatch({ sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null, message: "hi" }, () => {});
    mgr.interrupt("s1");
    expect(interrupts).toBe(1);
  });
});

describe("RunnerManager warm-process lifecycle", () => {
  // Adapter whose handles track spawn count, closed state, warmup, and close.
  function warmAdapter(opts: { closedAfterTurn?: boolean } = {}) {
    const state = { spawns: 0, warmups: 0, closes: 0 };
    const make = (resumeId: string | null): RunnerSessionHandle => {
      let closed = false;
      return {
        get runnerSessionId() { return resumeId; },
        get closed() { return closed; },
        async warmup() { state.warmups += 1; },
        async *send() {
          yield { type: "text", text: "hi" } as const;
          yield { type: "done" } as const;
          if (opts.closedAfterTurn) closed = true;
        },
        async close() { state.closes += 1; closed = true; },
      };
    };
    const adapter: RunnerAdapter = {
      id: "claude-code",
      capabilities: ["streaming"],
      startSession: vi.fn(async () => { state.spawns += 1; return make(null); }),
      resumeSession: vi.fn(async (id: string) => { state.spawns += 1; return make(id); }),
    };
    return { adapter, state };
  }

  it("reuses one handle across dispatches of the same session", async () => {
    const { adapter, state } = warmAdapter();
    const mgr = new RunnerManager();
    mgr.register(adapter);
    const d = { sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null, message: "go" };
    await mgr.dispatch(d, () => {});
    await mgr.dispatch(d, () => {});
    expect(state.spawns).toBe(1);
  });

  it("evicts a handle that closed during its turn, re-spawning on the next dispatch", async () => {
    const { adapter, state } = warmAdapter({ closedAfterTurn: true });
    const mgr = new RunnerManager();
    mgr.register(adapter);
    const d = { sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null, message: "go" };
    await mgr.dispatch(d, () => {});
    await mgr.dispatch(d, () => {});
    expect(state.spawns).toBe(2);
  });

  it("prewarm() spawns + warms the process, and the later dispatch reuses it", async () => {
    const { adapter, state } = warmAdapter();
    const mgr = new RunnerManager();
    mgr.register(adapter);
    await mgr.prewarm({ sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null });
    expect(state.spawns).toBe(1);
    expect(state.warmups).toBe(1);
    await mgr.dispatch({ sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null, message: "go" }, () => {});
    expect(state.spawns).toBe(1); // dispatch reused the prewarmed handle
  });

  it("prewarm() is a no-op when a handle already exists", async () => {
    const { adapter, state } = warmAdapter();
    const mgr = new RunnerManager();
    mgr.register(adapter);
    await mgr.prewarm({ sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null });
    await mgr.prewarm({ sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null });
    expect(state.spawns).toBe(1);
  });

  it("caps concurrent warm handles, evicting the least-recently-used", async () => {
    const { adapter, state } = warmAdapter();
    const mgr = new RunnerManager();
    mgr.register(adapter);
    // 8 is the cap; prewarm 9 distinct sessions → the first (LRU) is evicted.
    for (let i = 0; i < 9; i++) {
      await mgr.prewarm({ sessionId: `s${i}`, threadId: `t${i}`, adapter: "claude-code", runnerSessionId: null });
    }
    expect(state.spawns).toBe(9);
    expect(state.closes).toBe(1); // exactly one LRU victim closed
    // s0 was evicted → dispatching it re-spawns; s8 is still warm → reused.
    await mgr.dispatch({ sessionId: "s0", threadId: "t0", adapter: "claude-code", runnerSessionId: null, message: "go" }, () => {});
    expect(state.spawns).toBe(10);
    await mgr.dispatch({ sessionId: "s8", threadId: "t8", adapter: "claude-code", runnerSessionId: null, message: "go" }, () => {});
    expect(state.spawns).toBe(10); // s8 reused, no new spawn
  });

  it("closeAll() closes every live handle and clears the cache", async () => {
    const { adapter, state } = warmAdapter();
    const mgr = new RunnerManager();
    mgr.register(adapter);
    await mgr.prewarm({ sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null });
    await mgr.closeAll();
    expect(state.closes).toBe(1);
    // a dispatch after closeAll spawns fresh
    await mgr.dispatch({ sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null, message: "go" }, () => {});
    expect(state.spawns).toBe(2);
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
