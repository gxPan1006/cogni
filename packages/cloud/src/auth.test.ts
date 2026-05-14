import { describe, it, expect } from "vitest";
import { makeAuth } from "./auth.js";

const auth = makeAuth({
  jwtSecret: "test-secret-test-secret-test-sec",
  google: { clientId: "x", clientSecret: "y", redirectUri: "http://localhost/cb" },
});

describe("makeAuth", () => {
  it("round-trips a session token", async () => {
    const token = await auth.issueToken({ userId: "u1", tenantId: "t1" });
    expect(await auth.verifyToken(token)).toEqual({ userId: "u1", tenantId: "t1" });
  });
  it("rejects a tampered token", async () => {
    const token = await auth.issueToken({ userId: "u1", tenantId: "t1" });
    expect(await auth.verifyToken(token + "x")).toBeNull();
  });
  it("rejects garbage", async () => {
    expect(await auth.verifyToken("not-a-jwt")).toBeNull();
  });
});
