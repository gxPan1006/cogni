import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb } from "./test-db.js";
import { findOrCreateUserByEmail } from "./users.js";
import {
  createAuthSession,
  listAuthSessionsForUser,
  getAuthSession,
  revokeAuthSession,
  touchAuthSession,
} from "./auth-sessions.js";

describe("auth_sessions", () => {
  let handle: Awaited<ReturnType<typeof makeTestDb>>;
  let userId: string;

  beforeEach(async () => {
    handle = await makeTestDb();
    const u = await findOrCreateUserByEmail(handle.db, "user@example.com");
    userId = u.id;
  });

  afterEach(async () => {
    await handle.close();
  });

  it("createAuthSession returns id + persists row", async () => {
    const s = await createAuthSession(handle.db, {
      userId,
      deviceName: "Chrome on macOS",
      userAgent: "Mozilla",
      ip: "1.2.3.4",
    });
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    const fetched = await getAuthSession(handle.db, s.id);
    expect(fetched?.userId).toBe(userId);
    expect(fetched?.deviceName).toBe("Chrome on macOS");
  });

  it("listAuthSessionsForUser excludes revoked + newest-first", async () => {
    const a = await createAuthSession(handle.db, { userId, deviceName: "Old Device" });
    const b = await createAuthSession(handle.db, { userId, deviceName: "New Device" });
    await revokeAuthSession(handle.db, a.id);
    const list = await listAuthSessionsForUser(handle.db, userId);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(b.id);
  });

  it("getAuthSession of a revoked session returns row with revokedAt set", async () => {
    const s = await createAuthSession(handle.db, { userId, deviceName: "X" });
    await revokeAuthSession(handle.db, s.id);
    const fetched = await getAuthSession(handle.db, s.id);
    expect(fetched?.revokedAt).not.toBeNull();
  });

  it("touchAuthSession bumps lastSeenAt", async () => {
    const s = await createAuthSession(handle.db, { userId, deviceName: "X" });
    const before = (await getAuthSession(handle.db, s.id))!.lastSeenAt;
    await new Promise((r) => setTimeout(r, 20));
    await touchAuthSession(handle.db, s.id);
    const after = (await getAuthSession(handle.db, s.id))!.lastSeenAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});
