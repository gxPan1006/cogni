import { describe, it, expect } from "vitest";
import { makeTestDb } from "./test-db.js";
import { tenants, users } from "./schema.js";
import { upsertIdentity, listIdentitiesForUser } from "./identities.js";

describe("user_identities repository", () => {
  it("upsertIdentity is idempotent for the same (kind, sub) pair", async () => {
    const { db, close } = await makeTestDb();
    const [tenant] = await db.insert(tenants).values({ name: "t" }).returning();
    const [user] = await db.insert(users).values({ tenantId: tenant!.id, email: "a@x.com" }).returning();

    await upsertIdentity(db, user!.id, "google", "g-123");
    await upsertIdentity(db, user!.id, "google", "g-123"); // duplicate — must not throw
    await upsertIdentity(db, user!.id, "email", "a@x.com");

    const ids = await listIdentitiesForUser(db, user!.id);
    expect(ids).toHaveLength(2);
    expect(ids.map((i) => `${i.kind}|${i.sub}`).sort()).toEqual(["email|a@x.com", "google|g-123"]);
    await close();
  });
});
