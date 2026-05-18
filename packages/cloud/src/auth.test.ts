import { describe, it, expect } from "vitest";
import { makeAuth } from "./auth.js";

const auth = makeAuth({
  jwtSecret: "test-secret-test-secret-test-sec",
  google: { clientId: "x", clientSecret: "y", redirectUri: "http://localhost/cb" },
});

describe("makeAuth", () => {
  it("round-trips a session token with sessionId", async () => {
    const token = await auth.issueToken({ userId: "u1", tenantId: "t1", sessionId: "s1" });
    expect(await auth.verifyToken(token)).toEqual({ userId: "u1", tenantId: "t1", sessionId: "s1" });
  });
  it("rejects a tampered token", async () => {
    const token = await auth.issueToken({ userId: "u1", tenantId: "t1", sessionId: "s1" });
    expect(await auth.verifyToken(token + "x")).toBeNull();
  });
  it("rejects garbage", async () => {
    expect(await auth.verifyToken("not-a-jwt")).toBeNull();
  });
  it("rejects a token without sessionId claim (legacy SP-1 token)", async () => {
    // Build a legacy-shape JWT (no sessionId) using the same secret.
    const { SignJWT } = await import("jose");
    const legacy = await new SignJWT({ userId: "u1", tenantId: "t1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(new TextEncoder().encode("test-secret-test-secret-test-sec"));
    expect(await auth.verifyToken(legacy)).toBeNull();
  });
});
