import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const encoded = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", encoded)).toBe(true);
    expect(await verifyPassword("wrong password", encoded)).toBe(false);
  });

  it("produces the documented scrypt$salt$key format with a random salt", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).toMatch(/^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    // Random per-hash salt → identical passwords hash to different strings.
    expect(a).not.toBe(b);
    // …but both still verify.
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("returns false (never throws) for a malformed/foreign encoding", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$abc$def")).toBe(false);
    expect(await verifyPassword("x", "scrypt$onlytwo")).toBe(false);
    expect(await verifyPassword("x", "scrypt$!!!$###")).toBe(false);
  });
});
