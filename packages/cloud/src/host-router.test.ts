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
  it("evicts the user's previous host when they re-register with a new hostId", () => {
    const router = new HostRouter();
    const oldSend = vi.fn();
    const newSend = vi.fn();
    router.register({ hostId: "h1", userId: "u1", send: oldSend });
    router.register({ hostId: "h2", userId: "u1", send: newSend });
    expect(router.getHostForUser("u1")).toMatchObject({ hostId: "h2" });
  });
});
