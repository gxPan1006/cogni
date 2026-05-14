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
});
