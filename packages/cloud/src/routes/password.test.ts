import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { makeTestDb } from "../db/test-db.js";
import { FakeTransport } from "../email/transport.js";
import { makeAuth } from "../auth.js";
import { users } from "../db/schema.js";
import { listIdentitiesForUser } from "../db/identities.js";
import { findOrLinkUser } from "../auth/find-or-link.js";
import { setUserPassword } from "../db/users.js";
import { hashPassword } from "../auth/password.js";
import { registerPasswordRoutes } from "./password.js";

async function buildApp() {
  const { db, close } = await makeTestDb();
  const auth = makeAuth({
    jwtSecret: "test-secret-at-least-32-chars-long-padding-padding",
    google: { clientId: "x", clientSecret: "y", redirectUri: "http://localhost/cb" },
  });
  const transport = new FakeTransport();
  const app = new Hono();
  registerPasswordRoutes(app, {
    db, auth,
    hosts: undefined as never,
    clients: undefined as never,
    chat: undefined as never,
    emailTransport: transport,
    magicLinkTtlMinutes: 15,
    publicUrl: "http://localhost:8787",
    webUrl: "http://localhost:5173",
  });
  return { db, auth, transport, app, close };
}

function postJson(app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function tokenFromUrl(url: string): string {
  return new URL(url).searchParams.get("token")!;
}

/** register {email,password} → pull the verify token out of the sent email. */
async function registerAndGetVerifyToken(app: Hono, transport: FakeTransport, email: string, password: string) {
  const res = await postJson(app, "/auth/password/register", { email, password });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  return tokenFromUrl(transport.verifications.at(-1)!.url);
}

describe("POST /auth/password/register + verify", () => {
  it("register → verify creates one user with a password hash + password identity", async () => {
    const { db, app, transport, auth, close } = await buildApp();
    const token = await registerAndGetVerifyToken(app, transport, "alice@x.com", "hunter2hunter");

    const res = await postJson(app, "/auth/password/verify", { token });
    expect(res.status).toBe(200);
    const { token: jwt } = await res.json() as { token: string };
    const claims = await auth.verifyToken(jwt);
    expect(claims).not.toBeNull();

    const rows = await db.select().from(users).where(eq(users.email, "alice@x.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.passwordHash).toBeTruthy();
    const ids = await listIdentitiesForUser(db, rows[0]!.id);
    expect(ids).toEqual([expect.objectContaining({ kind: "password", sub: "alice@x.com" })]);
    await close();
  });

  it("register → verify MERGES into an existing Google user (one user, two identities)", async () => {
    const { db, app, transport, close } = await buildApp();
    // Pre-existing Google account for the same email.
    const google = await findOrLinkUser(db, { kind: "google", sub: "g-123", email: "bob@x.com" });

    const token = await registerAndGetVerifyToken(app, transport, "bob@x.com", "hunter2hunter");
    const res = await postJson(app, "/auth/password/verify", { token });
    expect(res.status).toBe(200);

    const rows = await db.select().from(users).where(eq(users.email, "bob@x.com"));
    expect(rows).toHaveLength(1);                      // merged, not duplicated
    expect(rows[0]!.id).toBe(google.userId);           // same user row
    expect(rows[0]!.passwordHash).toBeTruthy();        // password now set on it
    const ids = await listIdentitiesForUser(db, rows[0]!.id);
    expect(ids.map((i) => i.kind).sort()).toEqual(["google", "password"]);
    await close();
  });

  it("registering an email that ALREADY has a password sends a reset (not a verify) and still returns ok", async () => {
    const { db, app, transport, close } = await buildApp();
    // Seed an already-registered password account directly (so this test's one
    // register call exercises the existing-password branch without tripping the
    // per-email register limiter).
    const seeded = await findOrLinkUser(db, { kind: "password", sub: "carol@x.com", email: "carol@x.com" });
    await setUserPassword(db, seeded.userId, await hashPassword("hunter2hunter"));

    // anti-enumeration → still ok:true, but no verify email; a recovery (reset)
    // email is sent instead (no silent password overwrite).
    const res = await postJson(app, "/auth/password/register", { email: "carol@x.com", password: "anotherpass1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(transport.verifications).toHaveLength(0);   // no verify — would be an overwrite path
    expect(transport.resets).toHaveLength(1);
    expect(transport.resets[0]!.to).toBe("carol@x.com");
    await close();
  });

  it("rejects a malformed email / too-short password", async () => {
    const { app, close } = await buildApp();
    expect((await postJson(app, "/auth/password/register", { email: "nope", password: "longenough1" })).status).toBe(400);
    expect((await postJson(app, "/auth/password/register", { email: "x@y.com", password: "short" })).status).toBe(400);
    await close();
  });

  it("rejects a reused verify token (single-use)", async () => {
    const { app, transport, close } = await buildApp();
    const token = await registerAndGetVerifyToken(app, transport, "dave@x.com", "hunter2hunter");
    expect((await postJson(app, "/auth/password/verify", { token })).status).toBe(200);
    const r2 = await postJson(app, "/auth/password/verify", { token });
    expect(r2.status).toBe(400);
    await close();
  });
});

describe("POST /auth/password/login", () => {
  async function seedUser(app: Hono, transport: FakeTransport, email: string, password: string) {
    const token = await registerAndGetVerifyToken(app, transport, email, password);
    await postJson(app, "/auth/password/verify", { token });
  }

  it("returns a usable JWT for the right password", async () => {
    const { app, transport, auth, close } = await buildApp();
    await seedUser(app, transport, "erin@x.com", "hunter2hunter");

    const res = await postJson(app, "/auth/password/login", { email: "erin@x.com", password: "hunter2hunter" },
      { "X-Forwarded-For": "203.0.113.20" });
    expect(res.status).toBe(200);
    const { token } = await res.json() as { token: string };
    expect(await auth.verifyToken(token)).not.toBeNull();
    await close();
  });

  it("returns 401 for a wrong password and for an unknown email (no oracle)", async () => {
    const { app, transport, close } = await buildApp();
    await seedUser(app, transport, "frank@x.com", "hunter2hunter");

    const wrong = await postJson(app, "/auth/password/login", { email: "frank@x.com", password: "nope-nope-1" },
      { "X-Forwarded-For": "203.0.113.21" });
    expect(wrong.status).toBe(401);

    const unknown = await postJson(app, "/auth/password/login", { email: "ghost@x.com", password: "whatever12" },
      { "X-Forwarded-For": "203.0.113.22" });
    expect(unknown.status).toBe(401);
    await close();
  });

  it("returns 401 when the email exists but has no password (Google-only user)", async () => {
    const { db, app, close } = await buildApp();
    await findOrLinkUser(db, { kind: "google", sub: "g-9", email: "goog@x.com" });
    const res = await postJson(app, "/auth/password/login", { email: "goog@x.com", password: "whatever12" });
    expect(res.status).toBe(401);
    await close();
  });
});

describe("POST /auth/password/reset", () => {
  it("reset request → confirm overwrites the hash; the old password stops working", async () => {
    const { app, transport, auth, close } = await buildApp();
    const t1 = await registerAndGetVerifyToken(app, transport, "heidi@x.com", "oldpassword1");
    await postJson(app, "/auth/password/verify", { token: t1 });

    const reqRes = await postJson(app, "/auth/password/reset/request", { email: "heidi@x.com" },
      { "X-Forwarded-For": "203.0.113.30" });
    expect(reqRes.status).toBe(200);
    expect(await reqRes.json()).toEqual({ ok: true });
    const resetToken = tokenFromUrl(transport.resets.at(-1)!.url);

    const confirm = await postJson(app, "/auth/password/reset/confirm", { token: resetToken, password: "newpassword1" });
    expect(confirm.status).toBe(200);
    expect(await auth.verifyToken((await confirm.json() as { token: string }).token)).not.toBeNull();

    // new password works, old does not
    const okNew = await postJson(app, "/auth/password/login", { email: "heidi@x.com", password: "newpassword1" },
      { "X-Forwarded-For": "203.0.113.31" });
    expect(okNew.status).toBe(200);
    const oldFails = await postJson(app, "/auth/password/login", { email: "heidi@x.com", password: "oldpassword1" },
      { "X-Forwarded-For": "203.0.113.32" });
    expect(oldFails.status).toBe(401);
    await close();
  });

  it("reset request for an unknown email is a silent no-op (no email, still ok)", async () => {
    const { app, transport, close } = await buildApp();
    const res = await postJson(app, "/auth/password/reset/request", { email: "nobody@x.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(transport.resets).toHaveLength(0);
    await close();
  });
});
