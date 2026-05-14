import { describe, it, expect } from "vitest";
import { makeTestDb } from "./test-db.js";
import { tenants } from "./schema.js";

describe("schema + test-db", () => {
  it("creates all tables and round-trips a tenant", async () => {
    const { db, close } = await makeTestDb();
    const [row] = await db.insert(tenants).values({ name: "acme" }).returning();
    expect(row?.name).toBe("acme");
    expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
    await close();
  });
});
