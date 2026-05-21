import type { Hono } from "hono";
import { z } from "zod";
import {
  upsertPushSubscription,
  deletePushSubscriptionByEndpoint,
} from "../db/push-subscriptions.js";
import type { ServerDeps } from "../server.js";

/**
 * Web Push routes (PWA notifications).
 *
 *  - GET  /api/push/vapid-public-key  → the public VAPID key the browser needs
 *    to call `pushManager.subscribe`. 503 when push isn't configured so the
 *    client can hide the "enable notifications" affordance gracefully.
 *  - POST /api/push/subscribe         → store this browser's push endpoint for
 *    the authenticated user (upsert by endpoint).
 *  - POST /api/push/unsubscribe       → forget an endpoint (user turned it off).
 *
 * Push registration is HTTP, not a WS frame, on purpose: the subscription must
 * persist independently of whether a socket is currently open. Bearer auth +
 * `claims` come from the /api/* middleware mounted in registerClientRoutes.
 */
const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  locale: z.string().max(16).optional(),
});

const unsubscribeSchema = z.object({ endpoint: z.string().url() });

export function registerPushRoutes(app: Hono, deps: ServerDeps): void {
  app.get("/api/push/vapid-public-key", (c) => {
    if (!deps.vapidPublicKey) return c.json({ error: "push not configured" }, 503);
    return c.json({ publicKey: deps.vapidPublicKey });
  });

  app.post("/api/push/subscribe", async (c) => {
    if (!deps.vapidPublicKey) return c.json({ error: "push not configured" }, 503);
    const { userId } = c.get("claims");
    const raw = await c.req.json().catch(() => null);
    const parsed = subscribeSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
    }
    const { endpoint, keys, locale } = parsed.data;
    await upsertPushSubscription(deps.db, {
      userId,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      locale,
      userAgent: c.req.header("user-agent") ?? null,
    });
    return c.json({ ok: true });
  });

  app.post("/api/push/unsubscribe", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = unsubscribeSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid body", details: parsed.error.flatten() }, 400);
    }
    await deletePushSubscriptionByEndpoint(deps.db, parsed.data.endpoint);
    return c.json({ ok: true });
  });
}
