import { describe, it, expect } from "vitest";
import { hostToCloudSchema, cloudToHostSchema, clientToCloudSchema, cloudToClientSchema } from "./protocol.js";

describe("protocol schemas", () => {
  // ---- Spec-mandated tests (5) ----
  it("parses a host register message", () => {
    const r = hostToCloudSchema.safeParse({
      t: "register", hostId: "h1", capabilities: ["streaming"], adapters: ["claude-code"], version: "0.0.0",
    });
    expect(r.success).toBe(true);
  });
  it("parses a cloud dispatch with null runnerSessionId", () => {
    const r = cloudToHostSchema.safeParse({
      t: "dispatch", sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null, message: "hi",
    });
    expect(r.success).toBe(true);
  });
  it("parses a client send message", () => {
    expect(clientToCloudSchema.safeParse({ t: "send", threadId: "t1", text: "hi" }).success).toBe(true);
  });
  it("parses a cloud→client event with seq", () => {
    const r = cloudToClientSchema.safeParse({
      t: "event", threadId: "t1", seq: 3, event: { type: "text", text: "hi" },
    });
    expect(r.success).toBe(true);
  });
  it("rejects an unknown host message tag", () => {
    expect(hostToCloudSchema.safeParse({ t: "bogus" }).success).toBe(false);
  });

  // ---- Extra wire-guard coverage ----

  // hostToCloudSchema variants
  it("parses a host heartbeat message", () => {
    expect(hostToCloudSchema.safeParse({ t: "heartbeat" }).success).toBe(true);
  });
  it("parses a host event message", () => {
    expect(hostToCloudSchema.safeParse({
      t: "event", sessionId: "s1", event: { type: "text", text: "hello" },
    }).success).toBe(true);
  });
  it("parses a host session-update message", () => {
    expect(hostToCloudSchema.safeParse({
      t: "session-update", sessionId: "s1", status: "completed",
    }).success).toBe(true);
  });
  it("rejects host register without capabilities", () => {
    expect(hostToCloudSchema.safeParse({ t: "register", hostId: "h1", adapters: [], version: "0.0.0" }).success).toBe(false);
  });

  // cloudToHostSchema variants
  it("parses a cloud registered message", () => {
    expect(cloudToHostSchema.safeParse({ t: "registered" }).success).toBe(true);
  });
  it("parses a cloud dispatch with non-null runnerSessionId", () => {
    expect(cloudToHostSchema.safeParse({
      t: "dispatch", sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: "rs1", message: "hi",
    }).success).toBe(true);
  });
  it("rejects cloud dispatch missing threadId", () => {
    expect(cloudToHostSchema.safeParse({
      t: "dispatch", sessionId: "s1", adapter: "claude-code", runnerSessionId: null, message: "hi",
    }).success).toBe(false);
  });

  // clientToCloudSchema variants
  it("parses a client subscribe message", () => {
    expect(clientToCloudSchema.safeParse({ t: "subscribe", threadId: "t1" }).success).toBe(true);
  });
  it("rejects client send missing text", () => {
    expect(clientToCloudSchema.safeParse({ t: "send", threadId: "t1" }).success).toBe(false);
  });

  // cloudToClientSchema variants
  it("parses a cloud→client message row", () => {
    expect(cloudToClientSchema.safeParse({
      t: "message", threadId: "t1", messageId: "m1", role: "assistant", content: "hi", createdAt: "2024-01-01T00:00:00Z",
    }).success).toBe(true);
  });
  it("parses a cloud→client host-status online", () => {
    expect(cloudToClientSchema.safeParse({ t: "host-status", online: true }).success).toBe(true);
  });
  it("parses a cloud→client error", () => {
    expect(cloudToClientSchema.safeParse({ t: "error", message: "something went wrong" }).success).toBe(true);
  });
  it("rejects cloud→client message with invalid role", () => {
    expect(cloudToClientSchema.safeParse({
      t: "message", threadId: "t1", messageId: "m1", role: "bot", content: "hi", createdAt: "2024-01-01T00:00:00Z",
    }).success).toBe(false);
  });
  it("rejects cloud→client event missing seq", () => {
    expect(cloudToClientSchema.safeParse({
      t: "event", threadId: "t1", event: { type: "text", text: "hi" },
    }).success).toBe(false);
  });
  it("rejects session-update with RunnerSessionStatus 'idle' (not a valid wire SessionStatus)", () => {
    expect(hostToCloudSchema.safeParse({ t: "session-update", sessionId: "s1", status: "idle" }).success).toBe(false);
  });
});
