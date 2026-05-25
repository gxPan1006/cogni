import { describe, it, expect } from "vitest";
import { makeTestDb } from "../db/test-db.js";
import { findOrCreateUserByEmail } from "../db/users.js";
import { createThread } from "../db/threads.js";
import { createAuthSession } from "../db/auth-sessions.js";
import { HostRouter } from "../host-router.js";
import { ClientHub } from "../client-hub.js";
import { ChatDomain } from "../domains/chat.js";
import { FakeTransport } from "../email/transport.js";
import { makeAuth } from "../auth.js";
import { createServer } from "../server.js";

/**
 * Route-level rig for the SP-1 thread CRUD endpoints, focused on the new
 * sidebar rename (PATCH) + delete (DELETE) handlers. Same shape as
 * routes/hosts.test.ts — pglite + fakes + a Bearer-attaching `req` helper —
 * but the thread routes are wired by `createServer` itself, so no manual
 * registration is needed.
 */
async function setup() {
  const { db, close } = await makeTestDb();
  const user = await findOrCreateUserByEmail(db, "alice@x.com");
  const auth = makeAuth({
    jwtSecret: "test-secret-test-secret-test-sec",
    google: { clientId: "x", clientSecret: "y", redirectUri: "http://x/cb" },
  });
  const session = await createAuthSession(db, { userId: user.id, deviceName: "test rig" });
  const token = await auth.issueToken({
    userId: user.id,
    tenantId: user.tenantId,
    sessionId: session.id,
  });
  const hosts = new HostRouter();
  const clients = new ClientHub();
  const chat = new ChatDomain(db, hosts, clients);
  const deps = {
    db, auth, hosts, clients, chat,
    emailTransport: new FakeTransport(),
    magicLinkTtlMinutes: 15,
    publicUrl: "http://localhost",
    webUrl: "https://chat.example.com",
  };
  const { app } = createServer(deps);

  async function req(path: string, init: RequestInit = {}) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    return app.request(path, { ...init, headers });
  }

  return { db, user, req, close };
}

describe("PATCH /api/threads/:id", () => {
  it("renames the conversation (200) and the new title shows up in GET", async () => {
    const { db, user, req, close } = await setup();
    const t = await createThread(db, { userId: user.id, tenantId: user.tenantId });

    const patch = await req(`/api/threads/${t.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Renamed in the rail" }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ ok: true });

    const list = (await (await req("/api/threads")).json()) as Array<{ id: string; title: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("Renamed in the rail");
    await close();
  });

  it("rejects an empty title (400)", async () => {
    const { db, user, req, close } = await setup();
    const t = await createThread(db, { userId: user.id, tenantId: user.tenantId });
    const patch = await req(`/api/threads/${t.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "" }),
    });
    expect(patch.status).toBe(400);
    await close();
  });
});

describe("DELETE /api/threads/:id", () => {
  it("soft-deletes the conversation (200) and it disappears from GET", async () => {
    const { db, user, req, close } = await setup();
    const keep = await createThread(db, { userId: user.id, tenantId: user.tenantId });
    const drop = await createThread(db, { userId: user.id, tenantId: user.tenantId });

    const del = await req(`/api/threads/${drop.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    const list = (await (await req("/api/threads")).json()) as Array<{ id: string }>;
    expect(list.map((t) => t.id)).toEqual([keep.id]);

    // The deleted thread's detail route now 404s.
    expect((await req(`/api/threads/${drop.id}`)).status).toBe(404);
    await close();
  });
});

describe("thread ownership enforcement", () => {
  it("cross-user PATCH / DELETE returns 404 (thread belongs to someone else)", async () => {
    const { db, req, close } = await setup();
    const bob = await findOrCreateUserByEmail(db, "bob@x.com");
    const bobsThread = await createThread(db, { userId: bob.id, tenantId: bob.tenantId });

    const patch = await req(`/api/threads/${bobsThread.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "stolen" }),
    });
    expect(patch.status).toBe(404);

    const del = await req(`/api/threads/${bobsThread.id}`, { method: "DELETE" });
    expect(del.status).toBe(404);
    await close();
  });
});
