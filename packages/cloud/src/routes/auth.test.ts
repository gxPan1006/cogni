import { describe, it, expect } from "vitest";
import { safeRedirect } from "./auth.js";
import { makeTestDb } from "../db/test-db.js";
import { listIdentitiesForUser, upsertIdentity } from "../db/identities.js";
import { findOrCreateUserByEmail } from "../db/users.js";

describe("safeRedirect", () => {
  it("allows the cogni:// deep-link scheme", () => {
    expect(safeRedirect("cogni://auth")).toBe("cogni://auth");
    expect(safeRedirect("cogni://auth/sub/path")).toBe("cogni://auth/sub/path");
  });
  it("rejects http(s) targets (open-redirect / token-exfil guard)", () => {
    expect(safeRedirect("https://evil.com")).toBe("cogni://auth");
    expect(safeRedirect("http://localhost/steal")).toBe("cogni://auth");
  });
  it("falls back to the default for missing or malformed input", () => {
    expect(safeRedirect(undefined)).toBe("cogni://auth");
    expect(safeRedirect("not a url")).toBe("cogni://auth");
    expect(safeRedirect("")).toBe("cogni://auth");
  });
});

describe("dev-token endpoint identity wiring", () => {
  it("findOrCreateUserByEmail + upsertIdentity together let the dev user log in twice without duplicating identities", async () => {
    const { db, close } = await makeTestDb();

    // Simulate two mint-dev-token calls
    const u1 = await findOrCreateUserByEmail(db, "dev-manual@local.test");
    await upsertIdentity(db, u1.id, "dev", "manual");
    const u2 = await findOrCreateUserByEmail(db, "dev-manual@local.test");
    await upsertIdentity(db, u2.id, "dev", "manual");

    expect(u1.id).toBe(u2.id);
    const ids = await listIdentitiesForUser(db, u1.id);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({ kind: "dev", sub: "manual" });
    await close();
  });
});
