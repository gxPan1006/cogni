import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { makeTestDb } from "../db/test-db.js";
import { findOrCreateUserByEmail } from "../db/users.js";
import { createAuthSession, getAuthSession } from "../db/auth-sessions.js";
import { makeAuth, type SessionClaims } from "../auth.js";
import { registerProfileRoutes } from "./profile.js";
import type { ServerDeps } from "../server.js";

async function makeTestServer() {
  const { db, close } = await makeTestDb();
  const auth = makeAuth({
    jwtSecret: "test-secret-test-secret-test-sec",
    google: { clientId: "x", clientSecret: "y", redirectUri: "http://x/cb" },
  });

  const app = new Hono<{ Variables: { claims: SessionClaims } }>();
  app.use("/api/*", async (c, next) => {
    const authHeader = c.req.header("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const claims = token ? await auth.verifyToken(token) : null;
    if (!claims) return c.json({ error: "unauthorized" }, 401);
    const session = await getAuthSession(db, claims.sessionId);
    if (!session || session.revokedAt !== null) return c.json({ error: "unauthorized" }, 401);
    c.set("claims", claims);
    await next();
  });

  const deps = { db, auth } as unknown as ServerDeps;
  registerProfileRoutes(app as unknown as Hono, deps);

  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function login(email = "alice@example.com") {
    const user = await findOrCreateUserByEmail(db, email);
    const session = await createAuthSession(db, { userId: user.id, deviceName: "test" });
    const token = await auth.issueToken({ userId: user.id, tenantId: user.tenantId, sessionId: session.id });
    return { token, userId: user.id };
  }
  async function stop() {
    await new Promise<void>((res) => server.close(() => res()));
    await close();
  }
  return { baseUrl, db, login, stop };
}

function withAuth(token: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}), Authorization: `Bearer ${token}` } };
}

// A tiny valid PNG data URL (1×1) — well under the size cap.
const SMALL_AVATAR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("profile routes", () => {
  let s: Awaited<ReturnType<typeof makeTestServer>>;
  beforeEach(async () => { s = await makeTestServer(); });
  afterEach(async () => { await s.stop(); });

  it("GET /api/me returns email with null name/avatar for a fresh user", async () => {
    const { token } = await s.login();
    const res = await fetch(`${s.baseUrl}/api/me`, withAuth(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "alice@example.com", name: null, avatar: null });
  });

  it("requires auth (401 without Bearer)", async () => {
    const res = await fetch(`${s.baseUrl}/api/me`);
    expect(res.status).toBe(401);
  });

  it("PATCH name updates it and GET reflects it", async () => {
    const { token } = await s.login();
    const res = await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ name: "  Alice Liddell  " }) }));
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("Alice Liddell"); // trimmed
    const after = await (await fetch(`${s.baseUrl}/api/me`, withAuth(token))).json();
    expect(after.name).toBe("Alice Liddell");
  });

  it("PATCH rejects a name longer than 50 chars (400)", async () => {
    const { token } = await s.login();
    const res = await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ name: "x".repeat(51) }) }));
    expect(res.status).toBe(400);
  });

  it("PATCH empty/whitespace name clears it to null", async () => {
    const { token } = await s.login();
    await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ name: "Bob" }) }));
    const res = await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ name: "   " }) }));
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBeNull();
  });

  it("PATCH a valid small avatar stores it; null clears it", async () => {
    const { token } = await s.login();
    const set = await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ avatar: SMALL_AVATAR }) }));
    expect(set.status).toBe(200);
    expect((await set.json()).avatar).toBe(SMALL_AVATAR);
    const cleared = await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ avatar: null }) }));
    expect((await cleared.json()).avatar).toBeNull();
  });

  it("PATCH rejects a non-image / wrong-mime avatar (400)", async () => {
    const { token } = await s.login();
    const res = await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ avatar: "data:text/plain;base64,aGVsbG8=" }) }));
    expect(res.status).toBe(400);
  });

  it("PATCH rejects an oversize avatar (>256KB) (400)", async () => {
    const { token } = await s.login();
    // ~360k base64 chars ≈ 270KB decoded — over the 256KB cap.
    const big = "data:image/png;base64," + "A".repeat(360_000);
    const res = await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ avatar: big }) }));
    expect(res.status).toBe(400);
  });

  it("PATCH leaves avatar untouched when only name is sent", async () => {
    const { token } = await s.login();
    await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ avatar: SMALL_AVATAR }) }));
    await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ name: "Carol" }) }));
    const after = await (await fetch(`${s.baseUrl}/api/me`, withAuth(token))).json();
    expect(after).toEqual({ email: "alice@example.com", name: "Carol", avatar: SMALL_AVATAR });
  });
});
