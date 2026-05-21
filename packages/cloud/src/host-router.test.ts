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

  describe("liveness (heartbeat-staleness reaping)", () => {
    it("register stamps lastSeen, so a fresh host is not stale", () => {
      const r = new HostRouter();
      r.register({ hostId: "h1", userId: "u1", send: () => {} }, 1_000);
      // 30s later, threshold 60s → still fresh
      expect(r.getStaleHosts(60_000, 31_000)).toEqual([]);
    });

    it("getStaleHosts returns hosts whose last frame is older than the threshold", () => {
      const r = new HostRouter();
      r.register({ hostId: "h1", userId: "u1", send: () => {} }, 1_000);
      // 61s later, threshold 60s → stale
      expect(r.getStaleHosts(60_000, 62_000)).toEqual(["h1"]);
    });

    it("touch refreshes lastSeen so a host that keeps beating never goes stale", () => {
      const r = new HostRouter();
      r.register({ hostId: "h1", userId: "u1", send: () => {} }, 1_000);
      r.touch("h1", 40_000); // heartbeat at 40s
      expect(r.getStaleHosts(60_000, 62_000)).toEqual([]); // 62-40 = 22s < 60s
      expect(r.getStaleHosts(60_000, 101_000)).toEqual(["h1"]); // 101-40 = 61s
    });

    it("touch on an unknown host is a no-op (does not resurrect it)", () => {
      const r = new HostRouter();
      r.touch("ghost", 5_000);
      expect(r.getStaleHosts(60_000, 100_000)).toEqual([]);
    });

    it("unregister clears liveness tracking", () => {
      const r = new HostRouter();
      r.register({ hostId: "h1", userId: "u1", send: () => {} }, 1_000);
      r.unregister("h1");
      expect(r.getStaleHosts(60_000, 999_000)).toEqual([]);
    });

    it("getStaleHosts reports the userId so the reaper can broadcast offline", () => {
      const r = new HostRouter();
      r.register({ hostId: "h1", userId: "u1", send: () => {} }, 1_000);
      expect(r.getStaleEntries(60_000, 62_000)).toEqual([{ hostId: "h1", userId: "u1" }]);
    });
  });
});
