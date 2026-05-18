import type { Context, Hono } from "hono";
import { sql } from "drizzle-orm";
import type { ServerDeps } from "../server.js";

/**
 * Liveness + readiness probe.
 *
 * SP-2 followup: replaces the trivial `app.get("/health", () => ok)` that only
 * proved the Node process was alive. Cloudflare's HTTP probe used to flap
 * green even when Postgres was unreachable or the SMTP transport had silently
 * died — operators noticed only when a user complained that no magic-link
 * arrived. This handler executes a cheap `SELECT 1` round-trip per request to
 * confirm the DB connection itself is usable, and (best-effort) surfaces
 * whatever signal the email transport exposes.
 *
 * Response shape (always JSON, never plain text):
 *   { ok: boolean,
 *     checks: { db: "ok" | "fail",
 *               emailTransport: "ok" | "unknown" } }
 *
 * HTTP status:
 *   • 200 when the DB ping succeeds (overall ok=true). emailTransport status
 *     does NOT gate liveness — the magic-link send path is non-critical for
 *     "the API process can serve requests at all", and no current transport
 *     implementation reports `lastSendAt`, so this field is "unknown" by
 *     design and shouldn't downgrade the probe.
 *   • 503 when the DB ping throws. CF then de-pools this origin and surfaces
 *     the outage instead of routing user traffic into a broken backend.
 *
 * User-visible behavior:
 *   • Healthy: `curl https://cloud.ai-cognit.com/healthz` → 200 + JSON, CF
 *     probe stays green, the web/desktop apps can sign in normally.
 *   • DB down: same curl → 503 + JSON `{ ok:false, checks:{ db:"fail", … } }`,
 *     CF probe flips red and load-balancer drops the origin until recovery.
 *
 * Path alias: both `/healthz` (the new canonical name) and `/health` (the
 * legacy path Cloudflare's probe is already configured for) are wired to the
 * same handler. Keeping `/health` alive avoids a coordinated infra change for
 * a routing rename.
 */
export function registerHealthRoutes(app: Hono, deps: ServerDeps): void {
  const handler = async (c: Context) => {
    let dbStatus: "ok" | "fail" = "ok";
    try {
      // Cheapest possible round-trip that still proves the pool can acquire a
      // connection AND the server responded. Drizzle's `sql` template tag
      // returns a parameterized statement compatible with both
      // drizzle-orm/neon-serverless and drizzle-orm/pglite, so the same line
      // works in prod and pglite tests.
      await deps.db.execute(sql`SELECT 1`);
    } catch {
      // Swallow the original error here — we don't want to leak DB error
      // strings into a public, unauthenticated endpoint. The unhandled
      // rejection (if any) would have been logged by the server's onError
      // hook in another code path; for the probe, "fail" is the signal.
      dbStatus = "fail";
    }

    // Best-effort transport status. No current EmailTransport implementation
    // exposes a `lastSendAt` (or `healthy`) field, so this is "unknown" today.
    // Extending the interface to add a real liveness signal is cross-cutting
    // (touches FakeTransport / Console / Resend / Smtp) and out of scope for
    // this followup — we read the field defensively so that *if* an
    // implementation later adds it, the probe starts reporting "ok"
    // automatically.
    const transport = deps.emailTransport as unknown as {
      lastSendAt?: unknown;
    };
    const emailStatus: "ok" | "unknown" =
      transport && typeof transport.lastSendAt !== "undefined" ? "ok" : "unknown";

    const body = {
      ok: dbStatus === "ok",
      checks: { db: dbStatus, emailTransport: emailStatus },
    };
    return c.json(body, dbStatus === "ok" ? 200 : 503);
  };

  app.get("/healthz", handler);
  // Alias kept for Cloudflare's existing HTTP probe config (see comment above).
  app.get("/health", handler);
}
