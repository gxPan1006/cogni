import { describe, it, expect } from "vitest";
import { makeTestDb } from "./test-db.js";
import { findOrCreateUserByEmail } from "./users.js";

describe("findOrCreateUserByEmail", () => {
  it("creates a tenant+user on first sight, returns same user on second", async () => {
    const { db, close } = await makeTestDb();
    const a = await findOrCreateUserByEmail(db, "a@x.com");
    const b = await findOrCreateUserByEmail(db, "a@x.com");
    expect(a.id).toBe(b.id);
    expect(a.tenantId).toBe(b.tenantId);
    expect(a.email).toBe("a@x.com");
    await close();
  });

  it("lowercases the email before lookup (idempotent on case)", async () => {
    const { db, close } = await makeTestDb();
    const a = await findOrCreateUserByEmail(db, "Mixed@Case.COM");
    const b = await findOrCreateUserByEmail(db, "mixed@case.com");
    expect(a.id).toBe(b.id);
    expect(a.email).toBe("mixed@case.com");
    await close();
  });
});
