import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "../db/test-db.js";
import { findOrLinkUser } from "./find-or-link.js";
import { listIdentitiesForUser } from "../db/identities.js";

describe("findOrLinkUser", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  beforeEach(async () => {
    const t = await makeTestDb();
    db = t.db;
    close = t.close;
  });
  afterEach(async () => { await close(); });

  it("creates a new user when neither identity nor email exists", async () => {
    const { userId } = await findOrLinkUser(db, { kind: "google", sub: "g-001", email: "new@example.com" });
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);
    const ids = await listIdentitiesForUser(db, userId);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({ kind: "google", sub: "g-001" });
  });

  it("reuses existing user when (kind, sub) already known", async () => {
    const first = await findOrLinkUser(db, { kind: "google", sub: "g-001", email: "u@x.com" });
    const second = await findOrLinkUser(db, { kind: "google", sub: "g-001", email: "renamed@x.com" });
    expect(second.userId).toBe(first.userId);
    // email change in Google account ≠ email update here — we leave users.email alone
    const ids = await listIdentitiesForUser(db, first.userId);
    expect(ids).toHaveLength(1);
  });

  it("merges by email: new identity attached to existing user", async () => {
    const goog = await findOrLinkUser(db, { kind: "google", sub: "g-002", email: "alice@x.com" });
    const mail = await findOrLinkUser(db, { kind: "email",  sub: "alice@x.com", email: "alice@x.com" });
    expect(mail.userId).toBe(goog.userId);
    const ids = await listIdentitiesForUser(db, goog.userId);
    expect(ids.map((i) => i.kind).sort()).toEqual(["email", "google"]);
  });

  it("email match is case-insensitive", async () => {
    const a = await findOrLinkUser(db, { kind: "google", sub: "g-003", email: "Bob@X.com" });
    const b = await findOrLinkUser(db, { kind: "email", sub: "bob@x.com", email: "bob@x.com" });
    expect(b.userId).toBe(a.userId);
  });
});
