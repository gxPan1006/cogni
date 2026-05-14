import { describe, it, expect } from "vitest";
import { runnerEventSchema, RUNNER_CAPABILITIES } from "./runner.js";

describe("runnerEventSchema", () => {
  it("accepts a text event", () => {
    const r = runnerEventSchema.safeParse({ type: "text", text: "hi" });
    expect(r.success).toBe(true);
  });
  it("accepts a session-id event", () => {
    expect(runnerEventSchema.safeParse({ type: "session-id", id: "abc" }).success).toBe(true);
  });
  it("rejects an unknown event type", () => {
    expect(runnerEventSchema.safeParse({ type: "nope" }).success).toBe(false);
  });
  it("rejects a text event missing text", () => {
    expect(runnerEventSchema.safeParse({ type: "text" }).success).toBe(false);
  });
  it("exposes the seven declared capabilities", () => {
    expect(RUNNER_CAPABILITIES).toContain("streaming");
    expect(RUNNER_CAPABILITIES).toHaveLength(7);
  });

  // --- accepts: remaining 5 variants ---
  it("accepts a tool-call event", () => {
    expect(runnerEventSchema.safeParse({ type: "tool-call", toolId: "t1", name: "Bash", input: { cmd: "ls" } }).success).toBe(true);
  });
  it("accepts a tool-result event", () => {
    expect(runnerEventSchema.safeParse({ type: "tool-result", toolId: "t1", output: "done" }).success).toBe(true);
  });
  it("accepts a permission-request event", () => {
    expect(runnerEventSchema.safeParse({ type: "permission-request", toolId: "t1", name: "Bash", input: {} }).success).toBe(true);
  });
  it("accepts a done event without usage", () => {
    expect(runnerEventSchema.safeParse({ type: "done" }).success).toBe(true);
  });
  it("accepts a done event with usage", () => {
    expect(runnerEventSchema.safeParse({ type: "done", usage: { input_tokens: 10 } }).success).toBe(true);
  });
  it("accepts an error event", () => {
    expect(runnerEventSchema.safeParse({ type: "error", code: "x", message: "boom" }).success).toBe(true);
  });

  // --- rejects: missing required fields ---
  it("rejects a tool-call event missing toolId", () => {
    expect(runnerEventSchema.safeParse({ type: "tool-call", name: "Bash", input: {} }).success).toBe(false);
  });
  it("rejects an error event missing message", () => {
    expect(runnerEventSchema.safeParse({ type: "error", code: "x" }).success).toBe(false);
  });
  it("rejects a done event with a non-numeric usage value", () => {
    expect(runnerEventSchema.safeParse({ type: "done", usage: { k: "not-a-number" } }).success).toBe(false);
  });
});
