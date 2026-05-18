import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { makeTestDb } from "../db/test-db.js";
import { FakeTransport } from "../email/transport.js";
import { registerHealthRoutes } from "./health.js";
import type { ServerDeps } from "../server.js";

/**
 * Inline test server for the /healthz route. We avoid createServer() here for
 * the same reason identities.test.ts does — the full server pulls in WS, host
 * router, chat domain, etc., none of which the health handler reads. Only db
 * and emailTransport are dereferenced, so the rest of ServerDeps is cast.
 *
 * `/healthz` is intentionally unauthenticated (Cloudflare's probe has no
 * bearer token), so there's no auth middleware to set up — just register the
 * route on a fresh Hono app and call it.
 */
async function makeTestServer(opts: { breakDb?: boolean } = {}) {
  const { db, close } = await makeTestDb();
  const emailTransport = new FakeTransport();

  const app = new Hono();
  const deps = { db, emailTransport } as unknown as ServerDeps;
  registerHealthRoutes(app, deps);

  // To exercise the 503 branch we need the SELECT 1 to throw. Closing the
  // underlying pglite database before issuing the request is the cleanest way
  // — drizzle then surfaces a real error rather than us monkey-patching
  // .execute on a typed db object.
  if (opts.breakDb) await close();

  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function stop() {
    await new Promise<void>((res) => server.close(() => res()));
    if (!opts.breakDb) await close();
  }

  return { baseUrl, stop };
}

describe("health routes", () => {
  let s: Awaited<ReturnType<typeof makeTestServer>>;
  afterEach(async () => { await s.stop(); });

  describe("happy path (DB reachable)", () => {
    beforeEach(async () => { s = await makeTestServer(); });

    it("GET /healthz returns 200 with ok=true and db=ok", async () => {
      const res = await fetch(`${s.baseUrl}/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        checks: { db: string; emailTransport: string };
      };
      expect(body.ok).toBe(true);
      expect(body.checks.db).toBe("ok");
      // FakeTransport has no `lastSendAt`, so the probe reports "unknown".
      // This is the intentional, documented behavior — the email check is
      // best-effort and must not gate liveness.
      expect(body.checks.emailTransport).toBe("unknown");
    });

    it("GET /health (legacy alias) returns the same payload as /healthz", async () => {
      // Cloudflare's existing probe is still pointed at /health; keeping the
      // alias prevents a coordinated infra change. This test pins that
      // contract so a future cleanup pass doesn't silently break the probe.
      const res = await fetch(`${s.baseUrl}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; checks: { db: string } };
      expect(body.ok).toBe(true);
      expect(body.checks.db).toBe("ok");
    });
  });

  describe("DB unreachable", () => {
    beforeEach(async () => { s = await makeTestServer({ breakDb: true }); });

    it("GET /healthz returns 503 with ok=false and db=fail when SELECT 1 throws", async () => {
      const res = await fetch(`${s.baseUrl}/healthz`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        ok: boolean;
        checks: { db: string };
      };
      expect(body.ok).toBe(false);
      expect(body.checks.db).toBe("fail");
    });
  });
});
