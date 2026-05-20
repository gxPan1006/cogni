/**
 * @vitest-environment node
 *
 * Pure-logic tests for the conversation timeline reducer. These lock the
 * behaviour that lets tool-call pills survive past `done` and across reloads:
 * completed turns are reconstructed from their events (prose + tools), paired
 * to their triggering user message — not collapsed to the text-only message
 * row.
 */
import { describe, it, expect } from "vitest";
import type { MessageView, RunnerEvent } from "@cogni/contract";
import {
  aggregateEvents, splitTurns, buildTimeline, toolInputPreview, isAwaitingProgress,
} from "./chat-timeline.js";

function msg(id: string, role: MessageView["role"], content: string): MessageView {
  return { id, threadId: "t", role, content, createdAt: "2026-05-20T00:00:00Z" };
}

describe("aggregateEvents", () => {
  it("concatenates consecutive text deltas and pairs tool-call with its result", () => {
    const blocks = aggregateEvents([
      { type: "text", text: "小猫的 " },
      { type: "text", text: "SVG 来了" },
      { type: "tool-call", toolId: "1", name: "Write", input: { file_path: "/x/cat.svg" } },
      { type: "tool-result", toolId: "1", output: "ok" },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "text", text: "小猫的 SVG 来了" });
    expect(blocks[1]).toMatchObject({ kind: "tool", name: "Write", status: "done", result: "ok" });
  });

  it("hides AskUserQuestion tool-calls (and their results)", () => {
    const blocks = aggregateEvents([
      { type: "tool-call", toolId: "q", name: "AskUserQuestion", input: {} },
      { type: "tool-result", toolId: "q", output: "x" },
    ]);
    expect(blocks).toHaveLength(0);
  });
});

describe("splitTurns", () => {
  it("splits on done/error terminators and keeps an unterminated tail as its own turn", () => {
    const turns = splitTurns([
      { type: "text", text: "a" },
      { type: "done" },
      { type: "text", text: "b" },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.at(-1)).toMatchObject({ type: "done" });
    expect(turns[1]).toEqual([{ type: "text", text: "b" }]);
  });
});

describe("buildTimeline", () => {
  const userWrite: RunnerEvent[] = [
    { type: "text", text: "画好了" },
    { type: "tool-call", toolId: "1", name: "Write", input: { file_path: "/x/cat.svg" } },
    { type: "tool-result", toolId: "1", output: "ok" },
    { type: "done" },
  ];

  it("renders a completed turn from its events — keeping the tool pill, not the text-only message", () => {
    const messages = [msg("u1", "user", "给我写个小猫的svg"), msg("a1", "assistant", "画好了")];
    const { rows, awaitingReply } = buildTimeline(messages, userWrite);
    expect(awaitingReply).toBe(false);
    expect(rows.map((r) => r.kind)).toEqual(["user", "assistant"]);
    const asst = rows[1]!;
    if (asst.kind !== "assistant") throw new Error("expected assistant row");
    expect(asst.streaming).toBe(false);
    expect(asst.blocks.some((b) => b.kind === "tool")).toBe(true);
  });

  it("marks the in-flight (unterminated) turn as streaming", () => {
    const messages = [msg("u1", "user", "hi")];
    const events: RunnerEvent[] = [{ type: "text", text: "thinking" }]; // no done yet
    const { rows } = buildTimeline(messages, events);
    const asst = rows[1]!;
    if (asst.kind !== "assistant") throw new Error("expected assistant row");
    expect(asst.streaming).toBe(true);
  });

  it("flags awaitingReply when the last user turn has no events yet", () => {
    const { rows, awaitingReply } = buildTimeline([msg("u1", "user", "hi")], []);
    expect(rows.map((r) => r.kind)).toEqual(["user"]);
    expect(awaitingReply).toBe(true);
  });

  it("pairs turns to user messages across multiple rounds", () => {
    const messages = [
      msg("u1", "user", "q1"), msg("a1", "assistant", "画好了"),
      msg("u2", "user", "q2"), msg("a2", "assistant", "again"),
    ];
    const events = [...userWrite, { type: "text", text: "again" } as RunnerEvent, { type: "done" } as RunnerEvent];
    const { rows } = buildTimeline(messages, events);
    expect(rows.map((r) => r.kind)).toEqual(["user", "assistant", "user", "assistant"]);
    // First turn keeps its tool pill; second is plain text.
    const a1 = rows[1]!, a2 = rows[3]!;
    if (a1.kind !== "assistant" || a2.kind !== "assistant") throw new Error("expected assistant rows");
    expect(a1.blocks.some((b) => b.kind === "tool")).toBe(true);
    expect(a2.blocks.some((b) => b.kind === "tool")).toBe(false);
  });

  it("falls back to plain message rows when no events are available (catchup-too-long path)", () => {
    const messages = [msg("u1", "user", "hi"), msg("a1", "assistant", "reply text")];
    const { rows } = buildTimeline(messages, []);
    expect(rows.map((r) => r.kind)).toEqual(["user", "assistant-text"]);
    const fallback = rows[1]!;
    if (fallback.kind !== "assistant-text") throw new Error("expected assistant-text row");
    expect(fallback.text).toBe("reply text");
  });
});

describe("isAwaitingProgress", () => {
  it("is true while the last user turn has produced no events (the bare-dots state)", () => {
    const tl = buildTimeline([msg("u1", "user", "把文件给我")], []);
    expect(tl.awaitingReply).toBe(true);
    expect(isAwaitingProgress(tl)).toBe(true);
  });

  it("is true while streaming text with no tool currently running", () => {
    const tl = buildTimeline([msg("u1", "user", "hi")], [{ type: "text", text: "thinking" }]);
    expect(isAwaitingProgress(tl)).toBe(true);
  });

  it("is false while a tool is actively running (visible progress — don't arm the timer)", () => {
    const events: RunnerEvent[] = [
      { type: "text", text: "let me check" },
      { type: "tool-call", toolId: "1", name: "Bash", input: { command: "pnpm build" } },
    ];
    const tl = buildTimeline([msg("u1", "user", "build it")], events);
    expect(isAwaitingProgress(tl)).toBe(false);
  });

  it("is false once the turn has terminated (done)", () => {
    const events: RunnerEvent[] = [{ type: "text", text: "done!" }, { type: "done" }];
    const tl = buildTimeline([msg("u1", "user", "hi"), msg("a1", "assistant", "done!")], events);
    expect(isAwaitingProgress(tl)).toBe(false);
  });

  it("is false for an empty thread", () => {
    expect(isAwaitingProgress(buildTimeline([], []))).toBe(false);
  });
});

describe("toolInputPreview", () => {
  it("shortens the ~/.cogni/threads/<uuid> workspace prefix to a relative path", () => {
    expect(
      toolInputPreview({ file_path: "/Users/me/.cogni/threads/8cdf6fae-1234/cat.svg" }),
    ).toBe("cat.svg");
  });
  it("surfaces the command for Bash and the pattern for Grep", () => {
    expect(toolInputPreview({ command: "ls -la" })).toBe("ls -la");
    expect(toolInputPreview({ pattern: "foo.*bar" })).toBe("foo.*bar");
  });
  it("falls back to compact JSON for unknown shapes", () => {
    expect(toolInputPreview({ weird: 1 })).toBe('{"weird":1}');
  });
});
