import { describe, it, expect, vi } from "vitest";
import { ClientHub } from "./client-hub.js";

describe("ClientHub", () => {
  it("broadcasts only to clients subscribed to the thread", () => {
    const hub = new ClientHub();
    const a = vi.fn(); const b = vi.fn();
    hub.register({ clientId: "a", userId: "u1", send: a });
    hub.register({ clientId: "b", userId: "u1", send: b });
    hub.subscribe("a", "t1");
    hub.broadcast("t1", { t: "host-status", online: true });
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });
  it("stops delivering after unregister", () => {
    const hub = new ClientHub();
    const a = vi.fn();
    hub.register({ clientId: "a", userId: "u1", send: a });
    hub.subscribe("a", "t1");
    hub.unregister("a");
    hub.broadcast("t1", { t: "host-status", online: true });
    expect(a).not.toHaveBeenCalled();
  });
  it("ignores subscribe from a client that was never registered", () => {
    const hub = new ClientHub();
    hub.subscribe("ghost", "t1");
    // a real client subscribing to the same thread still works, and the ghost gets nothing
    const a = vi.fn();
    hub.register({ clientId: "a", userId: "u1", send: a });
    hub.subscribe("a", "t1");
    hub.broadcast("t1", { t: "host-status", online: true });
    expect(a).toHaveBeenCalledOnce();
  });
  it("sendToUser delivers to every client of that user only", () => {
    const hub = new ClientHub();
    const a = vi.fn(); const b = vi.fn(); const c = vi.fn();
    hub.register({ clientId: "a", userId: "u1", send: a });
    hub.register({ clientId: "b", userId: "u1", send: b });
    hub.register({ clientId: "c", userId: "u2", send: c });
    hub.sendToUser("u1", { t: "host-status", online: false });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(c).not.toHaveBeenCalled();
  });

  // ---- SP-2 T12: host-meta fan-out ----
  it("publishHostMeta delivers to every client of the host's user only", () => {
    const hub = new ClientHub();
    const a = vi.fn(); const b = vi.fn(); const c = vi.fn();
    hub.register({ clientId: "a", userId: "u1", send: a });
    hub.register({ clientId: "b", userId: "u1", send: b });
    hub.register({ clientId: "c", userId: "u2", send: c });
    hub.publishHostMeta("u1", { hostId: "h1", name: "Mac", status: "online", lastSeen: "2026-05-18T00:00:00Z" });
    expect(a).toHaveBeenCalledWith(expect.objectContaining({ t: "host-meta", hostId: "h1" }));
    expect(b).toHaveBeenCalledWith(expect.objectContaining({ t: "host-meta", hostId: "h1" }));
    expect(c).not.toHaveBeenCalled();
  });

  // ---- SP-2 T13: list-subscription + per-conn fan-out ----
  it("subscribeList delivers thread-meta only to list-subscribed clients of that user", () => {
    const hub = new ClientHub();
    const a = vi.fn(); const b = vi.fn(); const c = vi.fn();
    hub.register({ clientId: "a", userId: "u1", send: a });
    hub.register({ clientId: "b", userId: "u1", send: b });
    hub.register({ clientId: "c", userId: "u2", send: c });
    hub.subscribeList("a");
    hub.publishThreadMeta("u1", { threadId: "t1", title: "Hi", lastMsgAt: "2026-01-01T00:00:00Z" });
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();   // not list-subscribed
    expect(c).not.toHaveBeenCalled();   // different user
  });

  it("unsubscribeThread removes only that thread's subscription", () => {
    const hub = new ClientHub();
    const a = vi.fn();
    hub.register({ clientId: "a", userId: "u1", send: a });
    hub.subscribe("a", "t1");
    hub.subscribe("a", "t2");
    hub.unsubscribeThread("a", "t1");
    hub.broadcast("t1", { t: "host-status", online: true });
    hub.broadcast("t2", { t: "host-status", online: false });
    expect(a).toHaveBeenCalledOnce();
  });

  it("sendToConn targets a single clientId, no others", () => {
    const hub = new ClientHub();
    const a = vi.fn(); const b = vi.fn();
    hub.register({ clientId: "a", userId: "u1", send: a });
    hub.register({ clientId: "b", userId: "u1", send: b });
    hub.sendToConn("a", { t: "no-host-online", pendingMessageId: "p1" });
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });
});
