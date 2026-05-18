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

describe("SP-2 ClientToCloud variants", () => {
  it("parses subscribe-list", () => {
    const r = clientToCloudSchema.safeParse({ t: "subscribe-list" });
    expect(r.success).toBe(true);
  });
  it("parses subscribe-thread with lastSeq", () => {
    const r = clientToCloudSchema.safeParse({ t: "subscribe-thread", threadId: "t1", lastSeq: 42 });
    expect(r.success).toBe(true);
  });
  it("parses subscribe-thread without lastSeq (defaults later)", () => {
    const r = clientToCloudSchema.safeParse({ t: "subscribe-thread", threadId: "t1" });
    expect(r.success).toBe(true);
  });
  it("parses unsubscribe-thread", () => {
    const r = clientToCloudSchema.safeParse({ t: "unsubscribe-thread", threadId: "t1" });
    expect(r.success).toBe(true);
  });
  it("parses resolve-fallback switch", () => {
    const r = clientToCloudSchema.safeParse({
      t: "resolve-fallback", pendingMessageId: "p1", action: "switch", targetHostId: "h1",
    });
    expect(r.success).toBe(true);
  });
  it("parses resolve-fallback cancel without targetHostId", () => {
    const r = clientToCloudSchema.safeParse({
      t: "resolve-fallback", pendingMessageId: "p1", action: "cancel",
    });
    expect(r.success).toBe(true);
  });
});

describe("SP-2 CloudToClient variants", () => {
  it("parses catchup-complete", () => {
    const r = cloudToClientSchema.safeParse({ t: "catchup-complete", threadId: "t1", latestSeq: 47 });
    expect(r.success).toBe(true);
  });
  it("parses thread-meta", () => {
    const r = cloudToClientSchema.safeParse({
      t: "thread-meta", threadId: "t1", title: "Hi", lastMsgAt: new Date().toISOString(),
    });
    expect(r.success).toBe(true);
  });
  it("parses thread-created", () => {
    const r = cloudToClientSchema.safeParse({
      t: "thread-created", thread: { id: "t1", title: "Hi", updatedAt: new Date().toISOString() },
    });
    expect(r.success).toBe(true);
  });
  it("parses thread-deleted", () => {
    const r = cloudToClientSchema.safeParse({ t: "thread-deleted", threadId: "t1" });
    expect(r.success).toBe(true);
  });
  it("parses device-list-changed", () => {
    expect(cloudToClientSchema.safeParse({ t: "device-list-changed" }).success).toBe(true);
  });
  it("parses host-meta online/offline", () => {
    const r = cloudToClientSchema.safeParse({
      t: "host-meta", hostId: "h1", name: "MacBook", status: "online", lastSeen: new Date().toISOString(),
    });
    expect(r.success).toBe(true);
  });
  it("parses host-fallback-prompt", () => {
    const r = cloudToClientSchema.safeParse({
      t: "host-fallback-prompt",
      pendingMessageId: "p1",
      preferred: { id: "h1", name: "Home", lastSeenAgoMs: 7200000 },
      alternatives: [{ id: "h2", name: "Work", lastSeenAgoMs: 1000 }],
    });
    expect(r.success).toBe(true);
  });
  it("parses no-host-online", () => {
    const r = cloudToClientSchema.safeParse({ t: "no-host-online", pendingMessageId: "p1" });
    expect(r.success).toBe(true);
  });
  it("parses catchup-too-long", () => {
    const r = cloudToClientSchema.safeParse({ t: "catchup-too-long", threadId: "t1", latestSeq: 12345 });
    expect(r.success).toBe(true);
  });
});
