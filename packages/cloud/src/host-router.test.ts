import { describe, it, expect, vi } from "vitest";
import { HostRouter } from "./host-router.js";

describe("HostRouter", () => {
  it("routes a dispatch to the user's connected host", () => {
    const router = new HostRouter();
    const send = vi.fn();
    router.register({ hostId: "h1", userId: "u1", send });
    const ok = router.dispatch("u1", { t: "dispatch", sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null, message: "hi" });
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });
  it("returns false when the user has no online host", () => {
    const router = new HostRouter();
    expect(router.dispatch("u1", { t: "registered" })).toBe(false);
  });
  it("forgets a host after unregister", () => {
    const router = new HostRouter();
    router.register({ hostId: "h1", userId: "u1", send: vi.fn() });
    router.unregister("h1");
    expect(router.getHostForUser("u1")).toBeNull();
  });
  it("evicts the user's previous host when they re-register with a new hostId", () => {
    const router = new HostRouter();
    const oldSend = vi.fn();
    const newSend = vi.fn();
    router.register({ hostId: "h1", userId: "u1", send: oldSend });
    router.register({ hostId: "h2", userId: "u1", send: newSend });
    router.dispatch("u1", { t: "dispatch", sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null, message: "hi" });
    expect(newSend).toHaveBeenCalledOnce();
    expect(oldSend).not.toHaveBeenCalled();
  });
});
