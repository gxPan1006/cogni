import { describe, it, expect } from "vitest";
import { makeTestDb } from "./test-db.js";
import { findOrCreateUser } from "./users.js";

describe("findOrCreateUser", () => {
  it("creates a tenant+user on first sight, returns same user on second", async () => {
    const { db, close } = await makeTestDb();
    const a = await findOrCreateUser(db, { oauthSub: "g|1", email: "a@x.com" });
    const b = await findOrCreateUser(db, { oauthSub: "g|1", email: "a@x.com" });
    expect(a.id).toBe(b.id);
    expect(a.tenantId).toBe(b.tenantId);
    await close();
  });
});
