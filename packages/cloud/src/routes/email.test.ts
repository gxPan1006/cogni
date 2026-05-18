import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../db/test-db.js";
import { FakeTransport } from "../email/transport.js";
import { makeAuth } from "../auth.js";
import { registerEmailRoutes } from "./email.js";

function buildApp(transport: FakeTransport) {
  const app = new Hono();
  registerEmailRoutes(app, {
    db: undefined as never,    // not needed for /send
    auth: undefined as never,  // not needed for /send
    hosts: undefined as never,
    clients: undefined as never,
    chat: undefined as never,
    emailTransport: transport,
    magicLinkTtlMinutes: 15,
    publicUrl: "http://localhost:8787",
  });
  return app;
}

describe("POST /auth/email/send", () => {
  it("accepts a valid email and dispatches one magic-link email", async () => {
    const transport = new FakeTransport();
    const app = buildApp(transport);
    const res = await app.request("/auth/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@x.com" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.to).toBe("a@x.com");
    expect(transport.sent[0]?.magicUrl).toMatch(/^cogni:\/\/auth\?magic=[A-Za-z0-9_-]{40,}$/);
    expect(transport.sent[0]?.expiresInMinutes).toBe(15);
  });

  it("returns 400 on a malformed email", async () => {
    const transport = new FakeTransport();
    const app = buildApp(transport);
    const res = await app.request("/auth/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
    expect(transport.sent).toHaveLength(0);
  });

  it("returns 400 when body is missing email", async () => {
    const transport = new FakeTransport();
    const app = buildApp(transport);
    const res = await app.request("/auth/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("rate-limits the same email: 2nd send within a minute returns 429", async () => {
    const transport = new FakeTransport();
    const app = buildApp(transport);
    const r1 = await app.request("/auth/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@x.com" }),
    });
    expect(r1.status).toBe(200);
    const r2 = await app.request("/auth/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@x.com" }),
    });
    expect(r2.status).toBe(429);
    expect(transport.sent).toHaveLength(1);
  });

  it("rate-limits per IP: many emails from the same IP get blocked", async () => {
    const transport = new FakeTransport();
    const app = buildApp(transport);
    const ipHeaders = { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.42" };
    // per-IP cap is 3/min in the route. Send 4 different emails:
    for (let i = 0; i < 3; i++) {
      const r = await app.request("/auth/email/send", {
        method: "POST", headers: ipHeaders,
        body: JSON.stringify({ email: `u${i}@x.com` }),
      });
      expect(r.status).toBe(200);
    }
    const r4 = await app.request("/auth/email/send", {
      method: "POST", headers: ipHeaders,
      body: JSON.stringify({ email: "u3@x.com" }),
    });
    expect(r4.status).toBe(429);
  });
});

async function buildAppWithDb() {
  const { db, close } = await makeTestDb();
  const auth = makeAuth({
    jwtSecret: "test-secret-at-least-32-chars-long-padding-padding",
    google: { clientId: "x", clientSecret: "y", redirectUri: "http://localhost/cb" },
  });
  const transport = new FakeTransport();
  const app = new Hono();
  registerEmailRoutes(app, {
    db, auth,
    hosts: undefined as never,
    clients: undefined as never,
    chat: undefined as never,
    emailTransport: transport,
    magicLinkTtlMinutes: 15,
    publicUrl: "http://localhost:8787",
  });
  return { db, auth, transport, app, close };
}

async function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /auth/email/callback", () => {
  it("returns a JWT after a successful send → callback round-trip", async () => {
    const { app, transport, auth, close } = await buildAppWithDb();
    await postJson(app, "/auth/email/send", { email: "a@x.com" });
    const magicUrl = transport.sent[0]!.magicUrl;
    const token = new URL(magicUrl).searchParams.get("magic")!;

    const res = await postJson(app, "/auth/email/callback", { magic: token });
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string };
    expect(typeof body.token).toBe("string");

    const claims = await auth.verifyToken(body.token);
    expect(claims).not.toBeNull();
    expect(typeof claims!.userId).toBe("string");
    await close();
  });

  it("rejects a reused token (single-use)", async () => {
    const { app, transport, close } = await buildAppWithDb();
    await postJson(app, "/auth/email/send", { email: "a@x.com" });
    const token = new URL(transport.sent[0]!.magicUrl).searchParams.get("magic")!;

    const r1 = await postJson(app, "/auth/email/callback", { magic: token });
    expect(r1.status).toBe(200);
    const r2 = await postJson(app, "/auth/email/callback", { magic: token });
    expect(r2.status).toBe(400);
    expect((await r2.json() as { error: string }).error).toBe("expired");
    await close();
  });

  it("rejects an unknown token", async () => {
    const { app, close } = await buildAppWithDb();
    const r = await postJson(app, "/auth/email/callback", { magic: "AAAA".repeat(8) });
    expect(r.status).toBe(400);
    await close();
  });

  it("rejects a malformed body", async () => {
    const { app, close } = await buildAppWithDb();
    const r = await postJson(app, "/auth/email/callback", {});
    expect(r.status).toBe(400);
    await close();
  });

  it("creates exactly one user + one 'email' identity for a successful login", async () => {
    const { db, app, transport, close } = await buildAppWithDb();
    const { listIdentitiesForUser } = await import("../db/identities.js");
    const { users } = await import("../db/schema.js");
    const { eq } = await import("drizzle-orm");

    await postJson(app, "/auth/email/send", { email: "a@x.com" });
    const token = new URL(transport.sent[0]!.magicUrl).searchParams.get("magic")!;
    await postJson(app, "/auth/email/callback", { magic: token });

    const userRows = await db.select().from(users).where(eq(users.email, "a@x.com"));
    expect(userRows).toHaveLength(1);
    const ids = await listIdentitiesForUser(db, userRows[0]!.id);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({ kind: "email", sub: "a@x.com" });
    await close();
  });
});
