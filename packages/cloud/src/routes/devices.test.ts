import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../db/test-db.js";
import { findOrCreateUserByEmail } from "../db/users.js";
import {
  createAuthSession,
  getAuthSession,
  touchAuthSession,
} from "../db/auth-sessions.js";
import { makeAuth, type Auth } from "../auth.js";
import { ClientHub } from "../client-hub.js";
import { HostRouter } from "../host-router.js";
import { ChatDomain } from "../domains/chat.js";
import { FakeTransport } from "../email/transport.js";
import { registerDevicesRoutes } from "./devices.js";
import type { ServerDeps } from "../server.js";
import type { AnyDb } from "../db/client.js";

/**
 * Inline test rig: a minimal Hono app with the same Bearer middleware shape
 * client.ts uses (verify JWT → load auth_session → 401 if revoked →
 * setClaims), so we exercise registerDevicesRoutes end-to-end without
 * standing up the whole server.
 */
function buildApp(db: AnyDb, auth: Auth, clients: ClientHub): Hono {
  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const claims = token ? await auth.verifyToken(token) : null;
    if (!claims) return c.json({ error: "unauthorized" }, 401);
    const session = await getAuthSession(db, claims.sessionId);
    if (!session || session.revokedAt !== null) {
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("claims", claims);
    void touchAuthSession(db, claims.sessionId).catch(() => undefined);
    await next();
  });
  const deps: ServerDeps = {
    db,
    auth,
    hosts: new HostRouter(),
    clients,
    // ChatDomain isn't used by devices routes — keep one around so the deps
    // object satisfies ServerDeps in case the routes ever grow a chat hook.
    chat: new ChatDomain(db, new HostRouter(), clients),
    emailTransport: new FakeTransport(),
    magicLinkTtlMinutes: 15,
    publicUrl: "http://localhost",
    webUrl: "http://localhost",
  };
  registerDevicesRoutes(app, deps);
  return app;
}

const JWT_SECRET = "test-secret-test-secret-test-sec";
function makeTestAuth(): Auth {
  return makeAuth({
    jwtSecret: JWT_SECRET,
    google: { clientId: "x", clientSecret: "y", redirectUri: "http://x/cb" },
  });
}

describe("devices routes", () => {
  let db: AnyDb;
  let close: () => Promise<void>;
  let auth: Auth;
  let clients: ClientHub;
  let app: Hono;
  // Test fixture: a user with two sessions ("Desktop App" + "Other Device"),
  // and a JWT signed against the first session id (the "current" device).
  let userId: string;
  let tenantId: string;
  let desktopSessionId: string;
  let otherSessionId: string;
  let token: string;
  let pubSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const made = await makeTestDb();
    db = made.db;
    close = made.close;
    auth = makeTestAuth();
    clients = new ClientHub();
    pubSpy = vi.spyOn(clients, "publishUserBroadcast");
    app = buildApp(db, auth, clients);

    const user = await findOrCreateUserByEmail(db, "owner@x.com");
    userId = user.id;
    tenantId = user.tenantId;
    // Create the "older" session first so lastSeenAt ordering is unambiguous;
    // the test asserts on isCurrent regardless of order so this is just hygiene.
    const desktop = await createAuthSession(db, {
      userId,
      deviceName: "Desktop App",
      userAgent: "cogni-desktop/0.1",
    });
    desktopSessionId = desktop.id;
    const other = await createAuthSession(db, {
      userId,
      deviceName: "Other Device",
      userAgent: "cogni-web/0.1",
    });
    otherSessionId = other.id;
    token = await auth.issueToken({
      userId,
      tenantId,
      sessionId: desktopSessionId,
    });
  });

  afterEach(async () => {
    await close();
  });

  it("GET /api/devices lists user sessions with isCurrent on the caller's", async () => {
    const res = await app.request("/api/devices", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      deviceName: string;
      isCurrent: boolean;
      createdAt: string;
      lastSeenAt: string;
    }>;
    expect(body).toHaveLength(2);
    const desktop = body.find((d) => d.id === desktopSessionId);
    const other = body.find((d) => d.id === otherSessionId);
    expect(desktop?.deviceName).toBe("Desktop App");
    expect(desktop?.isCurrent).toBe(true);
    expect(other?.deviceName).toBe("Other Device");
    expect(other?.isCurrent).toBe(false);
    // Sanity-check ISO date serialisation — the UI parses these as Date strings.
    expect(typeof desktop?.createdAt).toBe("string");
    expect(() => new Date(desktop!.createdAt).toISOString()).not.toThrow();
  });

  it("DELETE /api/devices/:id revokes the session, broadcasts, and drops it from the list", async () => {
    const del = await app.request(`/api/devices/${otherSessionId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    // Other clients of the same user are notified to re-pull the settings list.
    expect(pubSpy).toHaveBeenCalledTimes(1);
    expect(pubSpy).toHaveBeenCalledWith(userId, { t: "device-list-changed" });

    // Re-listing now returns only the still-active "current" session.
    const list = await app.request("/api/devices", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await list.json()) as Array<{ id: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe(desktopSessionId);
  });

  it("DELETE /api/devices/:id returns 404 when the session belongs to a different user", async () => {
    // Spin up a second user with their own session, then try to revoke it
    // using the first user's JWT.
    const otherUser = await findOrCreateUserByEmail(db, "intruder@x.com");
    const victim = await createAuthSession(db, {
      userId: otherUser.id,
      deviceName: "Victim Device",
    });

    const res = await app.request(`/api/devices/${victim.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    expect(pubSpy).not.toHaveBeenCalled();

    // The targeted session is still active in its own owner's list — i.e. our
    // unauthorised DELETE did not silently revoke it.
    const stillThere = await getAuthSession(db, victim.id);
    expect(stillThere?.revokedAt).toBeNull();
  });
});
