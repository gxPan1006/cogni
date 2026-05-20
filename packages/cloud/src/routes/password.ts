import type { Context, Hono } from "hono";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { RateLimiter } from "../rate-limit.js";
import { findOrLinkUser } from "../auth/find-or-link.js";
import { findUserByEmail, setUserPassword } from "../db/users.js";
import { createAuthSession } from "../db/auth-sessions.js";
import { deriveDeviceName } from "../auth/device-name.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { InMemoryTokenStore, type TokenStore } from "../auth/token-store.js";
import { logger } from "@cogni/shared";
import type { ServerDeps } from "../server.js";

type Origin = "desktop" | "web";

interface PendingVerify { email: string; passwordHash: string; origin: Origin }
interface PendingReset { email: string; origin: Origin }

// Verify / reset tokens live longer than the magic-link's 15 min because the
// user may need to set/recall a password from a different device.
const TOKEN_TTL_MINUTES = 30;

const PASSWORD = z.string().min(8, "密码至少 8 位").max(200);
const registerSchema = z.object({
  email: z.string().email(),
  password: PASSWORD,
  origin: z.enum(["desktop", "web"]).optional(),
});
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
const resetRequestSchema = z.object({
  email: z.string().email(),
  origin: z.enum(["desktop", "web"]).optional(),
});
const tokenSchema = z.object({ token: z.string().min(20).max(128) });
const resetConfirmSchema = z.object({ token: z.string().min(20).max(128), password: PASSWORD });

/**
 * Email + password auth. The account identifier is the email — there is no
 * separate username, so a password attaches to the same email-keyed user as
 * Google / magic-link. Setting a password requires proven email ownership, so
 * the merge can never be used to take over a stranger's existing account:
 *
 *   POST /auth/password/register {email, password}
 *     - validates; if the email already has a password, sends a reset/recovery
 *       email instead of stashing (no silent overwrite); otherwise hashes the
 *       password, stashes {email, hash} and sends a VERIFY email.
 *     - always {ok:true} (anti-enumeration).
 *   POST /auth/password/verify {token}
 *     - redeems the verify token (single-use). Email is now proven →
 *       findOrLinkUser create-or-merges, writes the hash + password identity,
 *       returns a 30-day JWT.
 *   POST /auth/password/login {email, password}
 *     - verifies the hash; any failure → generic 401.
 *   POST /auth/password/reset/request {email}
 *     - sends a reset email if the user has a password; always {ok:true}.
 *   POST /auth/password/reset/confirm {token, password}
 *     - redeems, overwrites the hash, returns a JWT.
 *
 * Pending verify/reset tokens use the same InMemoryTokenStore as magic-link
 * (single-node SP-2; SP-2+1 swaps in Redis).
 */
export function registerPasswordRoutes(app: Hono, deps: ServerDeps): void {
  const ttlMs = TOKEN_TTL_MINUTES * 60_000;
  const pendingVerify: TokenStore<PendingVerify> = new InMemoryTokenStore<PendingVerify>({ ttlMs });
  const pendingReset: TokenStore<PendingReset> = new InMemoryTokenStore<PendingReset>({ ttlMs });
  setInterval(() => {
    void pendingVerify.sweep();
    void pendingReset.sweep();
  }, 5 * 60_000).unref();

  // register + reset each send an email → magic-link-style send limits, but
  // kept independent per endpoint so a just-registered user isn't locked out
  // of a reset for a full minute. Each is still 1/min per email = strong
  // anti-spam for that inbox.
  const mkSendLimiters = () => ({
    email: new RateLimiter([
      { windowMs: 60_000,    max: 1 },
      { windowMs: 3_600_000, max: 5 },
    ]),
    ip: new RateLimiter([
      { windowMs: 60_000,    max: 3 },
      { windowMs: 3_600_000, max: 20 },
    ]),
  });
  const registerLimit = mkSendLimiters();
  const resetLimit = mkSendLimiters();
  // Login isn't an email send; allow a few tries but throttle brute-force.
  const loginPerEmail = new RateLimiter([
    { windowMs: 60_000,    max: 5 },
    { windowMs: 3_600_000, max: 50 },
  ]);
  const loginPerIp = new RateLimiter([
    { windowMs: 60_000,    max: 10 },
    { windowMs: 3_600_000, max: 100 },
  ]);

  const clientIp = (c: Context): string =>
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? c.req.header("x-real-ip")
    ?? "unknown";

  const verifyUrlFor = (origin: Origin, token: string): string =>
    origin === "web"
      ? `${deps.webUrl}/auth/password/callback?token=${token}`
      : `cogni://auth?verify=${token}`;
  const resetUrlFor = (origin: Origin, token: string): string =>
    origin === "web"
      ? `${deps.webUrl}/auth/password/reset?token=${token}`
      : `cogni://auth?reset=${token}`;

  // ─── register ──────────────────────────────────────────────────────────
  app.post("/auth/password/register", async (c) => {
    const parsed = registerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid email or password" }, 400);
    const email = parsed.data.email.toLowerCase();
    const origin: Origin = parsed.data.origin ?? "web";

    if (!registerLimit.email.check(email) || !registerLimit.ip.check(clientIp(c))) {
      return c.json({ error: "rate limited" }, 429);
    }

    try {
      const existing = await findUserByEmail(deps.db, email);
      if (existing?.passwordHash) {
        // Already has a password. Don't overwrite via register (that's the
        // reset flow); send a recovery email so a forgetful owner has a path,
        // and still return ok so callers can't enumerate registered emails.
        const token = randomBytes(32).toString("base64url");
        await pendingReset.set(token, { email, origin });
        await deps.emailTransport.sendPasswordReset({
          to: email, url: resetUrlFor(origin, token), expiresInMinutes: TOKEN_TTL_MINUTES,
        });
        return c.json({ ok: true });
      }

      const passwordHash = await hashPassword(parsed.data.password);
      const token = randomBytes(32).toString("base64url");
      await pendingVerify.set(token, { email, passwordHash, origin });
      await deps.emailTransport.sendVerifyEmail({
        to: email, url: verifyUrlFor(origin, token), expiresInMinutes: TOKEN_TTL_MINUTES,
      });
    } catch (err) {
      logger.warn({ err: String(err), email }, "password register send failed");
      // still ok:true — never leak transport health or account existence
    }
    return c.json({ ok: true });
  });

  // ─── verify (commit registration) ────────────────────────────────────────
  app.post("/auth/password/verify", async (c) => {
    const parsed = tokenSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid" }, 400);
    const entry = await pendingVerify.get(parsed.data.token);
    if (!entry) return c.json({ error: "expired" }, 400);
    await pendingVerify.delete(parsed.data.token);

    // Email is verified by clicking the link → safe to create-or-merge.
    const user = await findOrLinkUser(deps.db, {
      kind: "password", sub: entry.email, email: entry.email,
    });
    await setUserPassword(deps.db, user.userId, entry.passwordHash);
    return c.json({ token: await issueFor(deps, c, user, entry.origin) });
  });

  // ─── login ──────────────────────────────────────────────────────────────
  app.post("/auth/password/login", async (c) => {
    const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid credentials" }, 401);
    const email = parsed.data.email.toLowerCase();

    if (!loginPerEmail.check(email) || !loginPerIp.check(clientIp(c))) {
      return c.json({ error: "rate limited" }, 429);
    }

    const user = await findUserByEmail(deps.db, email);
    // Same generic 401 whether the email is unknown, has no password, or the
    // password is wrong — no oracle for which.
    if (!user?.passwordHash || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
      return c.json({ error: "invalid credentials" }, 401);
    }
    return c.json({
      token: await issueFor(deps, c, { userId: user.id, tenantId: user.tenantId }, "web"),
    });
  });

  // ─── reset request ────────────────────────────────────────────────────────
  app.post("/auth/password/reset/request", async (c) => {
    const parsed = resetRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid email" }, 400);
    const email = parsed.data.email.toLowerCase();
    const origin: Origin = parsed.data.origin ?? "web";

    if (!resetLimit.email.check(email) || !resetLimit.ip.check(clientIp(c))) {
      return c.json({ error: "rate limited" }, 429);
    }

    try {
      const user = await findUserByEmail(deps.db, email);
      if (user?.passwordHash) {
        const token = randomBytes(32).toString("base64url");
        await pendingReset.set(token, { email, origin });
        await deps.emailTransport.sendPasswordReset({
          to: email, url: resetUrlFor(origin, token), expiresInMinutes: TOKEN_TTL_MINUTES,
        });
      }
    } catch (err) {
      logger.warn({ err: String(err), email }, "password reset send failed");
    }
    return c.json({ ok: true });
  });

  // ─── reset confirm ────────────────────────────────────────────────────────
  app.post("/auth/password/reset/confirm", async (c) => {
    const parsed = resetConfirmSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid" }, 400);
    const entry = await pendingReset.get(parsed.data.token);
    if (!entry) return c.json({ error: "expired" }, 400);
    await pendingReset.delete(parsed.data.token);

    // Clicking the reset link proves ownership → create-or-merge is safe even
    // if the email never had a password before (recovery from register).
    const user = await findOrLinkUser(deps.db, {
      kind: "password", sub: entry.email, email: entry.email,
    });
    await setUserPassword(deps.db, user.userId, await hashPassword(parsed.data.password));
    return c.json({ token: await issueFor(deps, c, user, entry.origin) });
  });
}

/** Create an auth_session for the request + issue a 30-day JWT. */
async function issueFor(
  deps: ServerDeps,
  c: Context,
  user: { userId: string; tenantId: string },
  origin: Origin,
): Promise<string> {
  const userAgent = c.req.header("user-agent") ?? undefined;
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const session = await createAuthSession(deps.db, {
    userId: user.userId,
    deviceName: deriveDeviceName(userAgent, origin),
    ...(userAgent !== undefined ? { userAgent } : {}),
    ...(ip ? { ip } : {}),
  });
  return deps.auth.issueToken({
    userId: user.userId,
    tenantId: user.tenantId,
    sessionId: session.id,
  });
}
