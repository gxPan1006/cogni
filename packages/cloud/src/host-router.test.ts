import { describe, it, expect, vi } from "vitest";
import { HostRouter } from "./host-router.js";

describe("HostRouter", () => {
  it("returns the connected host for a registered user", () => {
    const router = new HostRouter();
    const send = vi.fn();
    router.register({ hostId: "h1", userId: "u1", send });
    expect(router.getHostForUser("u1")).toMatchObject({ hostId: "h1", userId: "u1" });
  });
  it("returns null when the user has no online host", () => {
    const router = new HostRouter();
    expect(router.getHostForUser("u1")).toBeNull();
  });
  it("forgets a host after unregister", () => {
    const router = new HostRouter();
    router.register({ hostId: "h1", userId: "u1", send: vi.fn() });
    router.unregister("h1");
    expect(router.getHostForUser("u1")).toBeNull();
  });
  it("register(host) with same hostId replaces the socket; different hostIds coexist", () => {
    const router = new HostRouter();
    const sendOldSocket = vi.fn();
    const sendNewSocket = vi.fn();
    const sendOther = vi.fn();
    // Same hostId re-registering: previous ConnectedHost replaced.
    router.register({ hostId: "h1", userId: "u1", send: sendOldSocket });
    router.register({ hostId: "h1", userId: "u1", send: sendNewSocket });
    expect(router.getHostByIdForUser("u1", "h1")?.send).toBe(sendNewSocket);
    // Different hostId on the same user coexists.
    router.register({ hostId: "h2", userId: "u1", send: sendOther });
    const ids = router.getOnlineHostsForUser("u1").map((h) => h.hostId).sort();
    expect(ids).toEqual(["h1", "h2"]);
  });

  it("getOnlineHostsForUser returns all online hosts for a user, most-recent first", () => {
    const r = new HostRouter();
    r.register({ hostId: "h1", userId: "u1", send: () => {} });
    r.register({ hostId: "h2", userId: "u1", send: () => {} });
    r.register({ hostId: "h3", userId: "u2", send: () => {} });
    const list = r.getOnlineHostsForUser("u1").map((h) => h.hostId).sort();
    expect(list).toEqual(["h1", "h2"]);
  });

  it("getHostByIdForUser returns the host iff owned by that user", () => {
    const r = new HostRouter();
    r.register({ hostId: "h1", userId: "u1", send: () => {} });
    r.register({ hostId: "h2", userId: "u2", send: () => {} });
    expect(r.getHostByIdForUser("u1", "h1")?.hostId).toBe("h1");
    expect(r.getHostByIdForUser("u1", "h2")).toBeNull();
    expect(r.getHostByIdForUser("u1", "missing")).toBeNull();
  });

  it("unregistering one host leaves others online for the same user", () => {
    const r = new HostRouter();
    r.register({ hostId: "h1", userId: "u1", send: () => {} });
    r.register({ hostId: "h2", userId: "u1", send: () => {} });
    r.unregister("h1");
    expect(r.getOnlineHostsForUser("u1").map((h) => h.hostId)).toEqual(["h2"]);
  });
});
