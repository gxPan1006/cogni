import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { makeTestDb } from "../db/test-db.js";
import { findOrCreateUserByEmail } from "../db/users.js";
import { upsertIdentity, listIdentitiesForUser } from "../db/identities.js";
import { createAuthSession, getAuthSession } from "../db/auth-sessions.js";
import { makeAuth, type SessionClaims } from "../auth.js";
import { registerIdentitiesRoutes } from "./identities.js";
import type { ServerDeps } from "../server.js";

/**
 * Inline mini-server for identities-only tests. Mirrors the Bearer-JWT +
 * auth_sessions revocation check from routes/client.ts so the middleware
 * contract this router depends on (claims on context, revoked → 401) is
 * actually exercised by the test, not just mocked away.
 *
 * We mount registerIdentitiesRoutes here directly rather than going through
 * createServer() because spinning up the full server (WS upgrades, host
 * router, chat domain, email transport) would couple these tests to
 * unrelated subsystems and slow them down.
 */
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
    if (!session || session.revokedAt !== null) {
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("claims", claims);
    await next();
  });

  // We pass a minimal ServerDeps — only db is read by this router, but
  // ServerDeps requires the full shape, so the rest are placeholder casts.
  const deps = { db, auth } as unknown as ServerDeps;
  registerIdentitiesRoutes(app as unknown as Hono, deps);

  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  /** Creates a user + an auth_session + a JWT carrying that sessionId. */
  async function login(email = "alice@example.com") {
    const user = await findOrCreateUserByEmail(db, email);
    const session = await createAuthSession(db, {
      userId: user.id,
      deviceName: "test",
    });
    const token = await auth.issueToken({
      userId: user.id,
      tenantId: user.tenantId,
      sessionId: session.id,
    });
    return { token, userId: user.id, tenantId: user.tenantId };
  }

  async function stop() {
    await new Promise<void>((res) => server.close(() => res()));
    await close();
  }

  return { baseUrl, db, login, stop };
}

function withAuth(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  };
}

describe("identities routes", () => {
  let s: Awaited<ReturnType<typeof makeTestServer>>;
  beforeEach(async () => { s = await makeTestServer(); });
  afterEach(async () => { await s.stop(); });

  it("GET /api/identities returns the user's identities", async () => {
    const { token, userId } = await s.login();
    await upsertIdentity(s.db, userId, "google", "g-1");
    await upsertIdentity(s.db, userId, "email", "alice@example.com");

    const res = await fetch(`${s.baseUrl}/api/identities`, withAuth(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ kind: string; sub: string }>;
    expect(body).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "google", sub: "g-1" }),
      expect.objectContaining({ kind: "email", sub: "alice@example.com" }),
    ]));
  });

  it("DELETE /api/identities/:kind/:sub removes one, returns 200 (when >= 2 remain)", async () => {
    const { token, userId } = await s.login();
    await upsertIdentity(s.db, userId, "google", "g-1");
    await upsertIdentity(s.db, userId, "email", "alice@example.com");

    const res = await fetch(
      `${s.baseUrl}/api/identities/google/g-1`,
      withAuth(token, { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const remaining = await listIdentitiesForUser(s.db, userId);
    expect(remaining.map((i) => i.kind).sort()).toEqual(["email"]);
  });

  it("DELETE refuses with 409 when it would leave the user with zero identities", async () => {
    const { token, userId } = await s.login();
    // Only one identity present — the email used to encode the sub in the URL
    // must round-trip through encodeURIComponent because of the "@".
    await upsertIdentity(s.db, userId, "email", "alice@example.com");

    const onlyIdent = (await listIdentitiesForUser(s.db, userId))[0]!;
    const res = await fetch(
      `${s.baseUrl}/api/identities/${onlyIdent.kind}/${encodeURIComponent(onlyIdent.sub)}`,
      withAuth(token, { method: "DELETE" }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/last identity/i);

    // Sanity: the row was not deleted.
    const after = await listIdentitiesForUser(s.db, userId);
    expect(after).toHaveLength(1);
  });

  it("DELETE someone else's identity returns 404 (no info leak about other accounts)", async () => {
    // User A authenticates; user B owns the identity we'll try to delete.
    const { token } = await s.login("alice@example.com");
    const bob = await findOrCreateUserByEmail(s.db, "bob@example.com");
    await upsertIdentity(s.db, bob.id, "google", "bobs-google-sub");

    const res = await fetch(
      `${s.baseUrl}/api/identities/google/bobs-google-sub`,
      withAuth(token, { method: "DELETE" }),
    );
    expect(res.status).toBe(404);

    // Bob's identity must still be there — A's request must not have touched it.
    const bobsIds = await listIdentitiesForUser(s.db, bob.id);
    expect(bobsIds).toEqual([
      expect.objectContaining({ kind: "google", sub: "bobs-google-sub" }),
    ]);
  });
});
