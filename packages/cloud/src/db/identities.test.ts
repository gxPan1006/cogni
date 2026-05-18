import { describe, it, expect } from "vitest";
import { makeTestDb } from "./test-db.js";
import { tenants, users } from "./schema.js";
import {
  upsertIdentity,
  listIdentitiesForUser,
  countIdentities,
  deleteIdentity,
} from "./identities.js";

async function seedUser() {
  const { db, close } = await makeTestDb();
  const [tenant] = await db.insert(tenants).values({ name: "t" }).returning();
  const [user] = await db
    .insert(users)
    .values({ tenantId: tenant!.id, email: `u-${Math.random().toString(36).slice(2)}@x.com` })
    .returning();
  return { db, user: user!, close };
}

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

  it("countIdentities returns the number of identities for a user", async () => {
    const { db, user, close } = await seedUser();
    expect(await countIdentities(db, user.id)).toBe(0);
    await upsertIdentity(db, user.id, "google", "g-1");
    await upsertIdentity(db, user.id, "email", "e@x.com");
    expect(await countIdentities(db, user.id)).toBe(2);
    await close();
  });

  it("deleteIdentity removes a single (kind, sub) for a user", async () => {
    const { db, user, close } = await seedUser();
    await upsertIdentity(db, user.id, "google", "g-1");
    await upsertIdentity(db, user.id, "email", "e@x.com");
    await deleteIdentity(db, user.id, "google", "g-1");
    const remaining = await listIdentitiesForUser(db, user.id);
    expect(remaining.map((i) => i.kind)).toEqual(["email"]);
    await close();
  });
});
