import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { makeTestDb, type TestDb } from "../db/test-db.js";
import { findOrCreateUserByEmail } from "../db/users.js";
import { createAuthSession } from "../db/auth-sessions.js";
import { listPushSubscriptionsForUser } from "../db/push-subscriptions.js";
import { makeAuth, type Auth } from "../auth.js";
import { ClientHub } from "../client-hub.js";
import { HostRouter } from "../host-router.js";
import { ChatDomain } from "../domains/chat.js";
import { FakeTransport } from "../email/transport.js";
import { registerPushRoutes } from "./push.js";
import type { ServerDeps } from "../server.js";
import type { AnyDb } from "../db/client.js";

function buildApp(db: AnyDb, auth: Auth, vapidPublicKey: string | null): Hono {
  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const claims = token ? await auth.verifyToken(token) : null;
    if (!claims) return c.json({ error: "unauthorized" }, 401);
    c.set("claims", claims);
    await next();
  });
  const clients = new ClientHub();
  const deps: ServerDeps = {
    db,
    auth,
    hosts: new HostRouter(),
    clients,
    chat: new ChatDomain(db, new HostRouter(), clients),
    emailTransport: new FakeTransport(),
    magicLinkTtlMinutes: 15,
    publicUrl: "http://localhost",
    webUrl: "http://localhost",
    vapidPublicKey,
  };
  registerPushRoutes(app, deps);
  return app;
}

const SUB = {
  endpoint: "https://push.example/endpoint-1",
  keys: { p256dh: "p256dh-key", auth: "auth-key" },
  locale: "zh",
};

describe("push routes", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let auth: Auth;
  let token: string;
  let userId: string;

  beforeEach(async () => {
    ({ db, close } = await makeTestDb());
    auth = makeAuth({ jwtSecret: "test-secret", google: { clientId: "x", clientSecret: "y", redirectUri: "z" } });
    const user = await findOrCreateUserByEmail(db, "push-routes@example.com");
    userId = user.id;
    const session = await createAuthSession(db, { userId, deviceName: "test" });
    token = await auth.issueToken({ userId, tenantId: user.tenantId, sessionId: session.id });
  });
  afterEach(async () => {
    await close();
  });

  it("GET vapid-public-key returns the key when configured", async () => {
    const app = buildApp(db, auth, "the-public-key");
    const res = await app.request("/api/push/vapid-public-key", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicKey: "the-public-key" });
  });

  it("GET vapid-public-key 503 when push not configured", async () => {
    const app = buildApp(db, auth, null);
    const res = await app.request("/api/push/vapid-public-key", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(503);
  });

  it("POST subscribe persists the subscription for the caller", async () => {
    const app = buildApp(db, auth, "k");
    const res = await app.request("/api/push/subscribe", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(SUB),
    });
    expect(res.status).toBe(200);
    const rows = await listPushSubscriptionsForUser(db, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ endpoint: SUB.endpoint, p256dh: "p256dh-key", locale: "zh" });
  });

  it("POST subscribe 400 on malformed body", async () => {
    const app = buildApp(db, auth, "k");
    const res = await app.request("/api/push/subscribe", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "not-a-url" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST subscribe 401 without a token", async () => {
    const app = buildApp(db, auth, "k");
    const res = await app.request("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SUB),
    });
    expect(res.status).toBe(401);
  });

  it("POST unsubscribe removes a stored endpoint", async () => {
    const app = buildApp(db, auth, "k");
    await app.request("/api/push/subscribe", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(SUB),
    });
    const res = await app.request("/api/push/unsubscribe", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: SUB.endpoint }),
    });
    expect(res.status).toBe(200);
    expect(await listPushSubscriptionsForUser(db, userId)).toHaveLength(0);
  });
});
