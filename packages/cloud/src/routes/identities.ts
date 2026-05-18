import type { Hono } from "hono";
import { countIdentities, deleteIdentity, listIdentitiesForUser } from "../db/identities.js";
import type { ServerDeps } from "../server.js";

/**
 * Settings → "Connected sign-in methods" backend.
 *
 * SP-2: surfaces the user_identities rows so the web/desktop settings UI can
 * show a row per linked provider (Google, Email magic-link, etc.) and let the
 * user remove one.
 *
 * Auth precondition: this router assumes the `/api/*` Bearer-JWT middleware in
 * server.ts has already validated the token and stashed claims on the context
 * (`c.get("claims")`). We don't re-mount the middleware here — it's a single
 * source of truth in routes/client.ts.
 *
 * Last-one guard: DELETE refuses (409) if it would drop the user to zero
 * identities. Otherwise the user would no longer have *any* way to sign back
 * in via the same email account on a new device — effectively self-locking
 * themselves out of cogni.
 *
 * Cross-user delete: DELETE on an identity that doesn't belong to the caller
 * returns 404 (not 403). Returning 403 would leak the existence of (kind,sub)
 * pairs across accounts; 404 keeps the response indistinguishable from a true
 * "no such identity" case.
 *
 * User-visible behavior:
 *   • Settings page lists each linked sign-in method with a "Remove" button.
 *   • Clicking Remove on the only remaining identity → red "Can't remove your
 *     last sign-in method" toast (driven by the 409 + error string here).
 *   • Clicking Remove on a second identity → row disappears, toast confirms.
 */
export function registerIdentitiesRoutes(app: Hono, deps: ServerDeps): void {
  app.get("/api/identities", async (c) => {
    const { userId } = c.get("claims");
    const ids = await listIdentitiesForUser(deps.db, userId);
    return c.json(ids);
  });

  app.delete("/api/identities/:kind/:sub", async (c) => {
    const { userId } = c.get("claims");
    const kind = c.req.param("kind");
    // `:sub` for an email identity contains "@" and possibly "+", "." — the
    // client must percent-encode (encodeURIComponent), and we reverse it here.
    const sub = decodeURIComponent(c.req.param("sub"));

    // Ownership check by enumeration. listIdentitiesForUser is bounded (a
    // user has a handful of identities, not thousands), so scanning + matching
    // is cheaper than a separate exists-and-belongs query. A miss returns 404
    // for both "doesn't exist" and "exists but belongs to someone else" —
    // intentional, to avoid leaking other users' (kind, sub) pairs.
    const all = await listIdentitiesForUser(deps.db, userId);
    if (!all.find((i) => i.kind === kind && i.sub === sub)) {
      return c.json({ error: "not found" }, 404);
    }

    // Re-count rather than relying on `all.length` for the guard. It's the
    // same value in practice, but the count query is the canonical authority
    // and makes the intent ("don't drop below 1") readable at the call site.
    const total = await countIdentities(deps.db, userId);
    if (total <= 1) {
      return c.json({ error: "cannot remove last identity" }, 409);
    }

    await deleteIdentity(deps.db, userId, kind, sub);
    return c.json({ ok: true });
  });
}
