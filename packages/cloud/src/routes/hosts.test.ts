import { describe, it, expect } from "vitest";
import { makeTestDb } from "../db/test-db.js";
import { findOrCreateUserByEmail } from "../db/users.js";
import { createHost, softRemoveHost } from "../db/hosts.js";
import { createAuthSession } from "../db/auth-sessions.js";
import { HostRouter } from "../host-router.js";
import { ClientHub } from "../client-hub.js";
import { ChatDomain } from "../domains/chat.js";
import { FakeTransport } from "../email/transport.js";
import { makeAuth } from "../auth.js";
import { createServer } from "../server.js";
import { registerHostsRoutes } from "./hosts.js";

/**
 * In-process test rig: spins up the full Hono app against pglite + fakes for
 * a single user, returns a `req(path, init)` helper that automatically attaches
 * the user's Bearer JWT so each test can hit the routes without re-doing the
 * auth dance.
 */
async function setup() {
  const { db, close } = await makeTestDb();
  const user = await findOrCreateUserByEmail(db, "alice@x.com");
  const auth = makeAuth({
    jwtSecret: "test-secret-test-secret-test-sec",
    google: { clientId: "x", clientSecret: "y", redirectUri: "http://x/cb" },
  });
  const session = await createAuthSession(db, {
    userId: user.id,
    deviceName: "test rig",
  });
  const token = await auth.issueToken({
    userId: user.id,
    tenantId: user.tenantId,
    sessionId: session.id,
  });
  const hosts = new HostRouter();
  const clients = new ClientHub();
  const chat = new ChatDomain(db, hosts, clients);
  const deps = {
    db,
    auth,
    hosts,
    clients,
    chat,
    emailTransport: new FakeTransport(),
    magicLinkTtlMinutes: 15,
    publicUrl: "http://localhost",
    webUrl: "https://chat.ai-cognit.com",
  };
  const { app } = createServer(deps);
  // server.ts integration of /api/hosts routes lands separately; register
  // them directly on the test app so the handlers under test are reachable.
  registerHostsRoutes(app, deps);

  async function req(path: string, init: RequestInit = {}) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    return app.request(path, { ...init, headers });
  }

  return { db, user, auth, hosts, clients, app, req, close };
}

describe("GET /api/hosts", () => {
  it("excludes soft-removed hosts (only the live one comes back)", async () => {
    const { db, user, req, close } = await setup();
    const a = await createHost(db, {
      userId: user.id,
      tenantId: user.tenantId,
      name: "Mac",
    });
    const b = await createHost(db, {
      userId: user.id,
      tenantId: user.tenantId,
      name: "Linux box",
    });
    // Tombstone the second one — the UI should never see it again.
    await softRemoveHost(db, b.hostId);

    const res = await req("/api/hosts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      name: string;
      status: string;
      lastSeen: string | null;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: a.hostId, name: "Mac", status: "offline" });
    // Freshly created host hasn't connected yet → no lastSeen.
    expect(body[0]!.lastSeen).toBeNull();
    await close();
  });
});

describe("PATCH /api/hosts/:id", () => {
  it("renames the host (200) and the new name shows up in GET", async () => {
    const { db, user, req, close } = await setup();
    const h = await createHost(db, {
      userId: user.id,
      tenantId: user.tenantId,
      name: "Old name",
    });

    const patch = await req(`/api/hosts/${h.hostId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "New shiny name" }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ ok: true });

    const list = await req("/api/hosts");
    const body = (await list.json()) as Array<{ id: string; name: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe("New shiny name");
    await close();
  });
});

describe("DELETE /api/hosts/:id", () => {
  it("soft-removes the host (200) and it disappears from GET", async () => {
    const { db, user, req, close } = await setup();
    const h = await createHost(db, {
      userId: user.id,
      tenantId: user.tenantId,
      name: "Soon-gone",
    });

    const del = await req(`/api/hosts/${h.hostId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    const list = await req("/api/hosts");
    expect(await list.json()).toEqual([]);
    await close();
  });
});

describe("ownership enforcement", () => {
  it("cross-user PATCH / DELETE returns 404 (host belongs to someone else)", async () => {
    const { db, req, close } = await setup();
    // Second user owns the host; the rig's JWT belongs to alice.
    const bob = await findOrCreateUserByEmail(db, "bob@x.com");
    const bobsHost = await createHost(db, {
      userId: bob.id,
      tenantId: bob.tenantId,
      name: "Bob's machine",
    });

    const patch = await req(`/api/hosts/${bobsHost.hostId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "stolen" }),
    });
    expect(patch.status).toBe(404);

    const del = await req(`/api/hosts/${bobsHost.hostId}`, { method: "DELETE" });
    expect(del.status).toBe(404);
    await close();
  });
});
