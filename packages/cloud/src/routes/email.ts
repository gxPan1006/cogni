import type { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { RateLimiter } from "../rate-limit.js";
import { findOrLinkUser } from "../auth/find-or-link.js";
import { createAuthSession } from "../db/auth-sessions.js";
import { deriveDeviceName } from "../auth/device-name.js";
import { logger } from "@cogni/shared";
import type { ServerDeps } from "../server.js";

type Origin = "desktop" | "web";

interface PendingMagic { email: string; origin: Origin; createdAt: number }

const emailSchema = z.object({
  email: z.string().email(),
  // SP-2: web SPA at chat.ai-cognit.com calls with origin="web" so the link in
  // the email points back to a https:// URL instead of a cogni:// deep link.
  origin: z.enum(["desktop", "web"]).optional(),
});
const magicSchema = z.object({ magic: z.string().min(20).max(128) });

/**
 * Magic-link email login.
 *
 *   POST /auth/email/send {email}
 *     - validates the email shape (zod)
 *     - rate-limits per email (1/min + 5/hour) and per IP (3/min + 20/hour)
 *     - generates a 32-byte base64url token, stores it in an in-process Map
 *       with the magicLinkTtlMinutes TTL, hands the magic URL to deps.emailTransport
 *     - always returns {ok:true} on accept (anti-enumeration — the client
 *       cannot tell whether the email is known or not)
 *
 *   POST /auth/email/callback {magic}
 *     - looks up the pending token; rejects unknown/expired tokens with 400
 *     - on hit: deletes the token (single-use), finds-or-creates the user by
 *       email, upserts an "email" identity, and returns a 30-day JWT
 *
 * In-process state means SP-1 must run as a single cloud node; SP-2 will
 * move pending tokens to a shared store (Redis / pg).
 */
export function registerEmailRoutes(app: Hono, deps: ServerDeps): void {
  const pending = new Map<string, PendingMagic>();
  const ttlMs = deps.magicLinkTtlMinutes * 60_000;

  // sweep every 5min so stale tokens don't pile up
  setInterval(() => {
    const cutoff = Date.now() - ttlMs;
    for (const [tok, v] of pending) if (v.createdAt < cutoff) pending.delete(tok);
  }, 5 * 60_000).unref();

  const perEmail = new RateLimiter([
    { windowMs: 60_000,    max: 1 },
    { windowMs: 3_600_000, max: 5 },
  ]);
  const perIp = new RateLimiter([
    { windowMs: 60_000,    max: 3 },
    { windowMs: 3_600_000, max: 20 },
  ]);

  app.post("/auth/email/send", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = emailSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid email" }, 400);
    const email = parsed.data.email.toLowerCase();
    const origin: Origin = parsed.data.origin ?? "desktop";

    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      ?? c.req.header("x-real-ip")
      ?? "unknown";
    if (!perEmail.check(email) || !perIp.check(ip)) {
      return c.json({ error: "rate limited" }, 429);
    }

    const token = randomBytes(32).toString("base64url");
    pending.set(token, { email, origin, createdAt: Date.now() });

    // The link the user clicks in their inbox depends on which client opened
    // the send. Desktop gets a cogni:// deep link that the Tauri app intercepts;
    // web gets a https:// URL that the SPA route handler picks up.
    const magicUrl = origin === "web"
      ? `${deps.webUrl}/auth/email/callback?token=${token}`
      : `cogni://auth?magic=${token}`;
    try {
      await deps.emailTransport.sendMagicLink({
        to: email,
        magicUrl,
        expiresInMinutes: deps.magicLinkTtlMinutes,
      });
    } catch (err) {
      logger.warn({ err: String(err), email }, "magic-link send failed");
      // intentionally still return ok:true — avoids leaking transport health
    }
    return c.json({ ok: true });
  });

  app.post("/auth/email/callback", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = magicSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid" }, 400);

    const entry = pending.get(parsed.data.magic);
    if (!entry || Date.now() - entry.createdAt > ttlMs) {
      pending.delete(parsed.data.magic);
      return c.json({ error: "expired" }, 400);
    }
    pending.delete(parsed.data.magic);

    // SP-2: findOrLinkUser auto-merges by verified email if the user already
    // exists under another provider (Google / dev-token). For magic-link the
    // identity sub IS the lowercased email.
    const user = await findOrLinkUser(deps.db, {
      kind: "email", sub: entry.email, email: entry.email,
    });
    const userAgent = c.req.header("user-agent") ?? undefined;
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    const session = await createAuthSession(deps.db, {
      userId: user.userId,
      deviceName: deriveDeviceName(userAgent, entry.origin),
      ...(userAgent !== undefined ? { userAgent } : {}),
      ...(ip ? { ip } : {}),
    });
    const token = await deps.auth.issueToken({
      userId: user.userId,
      tenantId: user.tenantId,
      sessionId: session.id,
    });
    return c.json({ token });
  });
}
