import type { Hono } from "hono";
import { generateState, generateCodeVerifier, decodeIdToken } from "arctic";
import { findOrLinkUser } from "../auth/find-or-link.js";
import { findOrCreateUserByEmail } from "../db/users.js";
import { upsertIdentity } from "../db/identities.js";
import { createAuthSession } from "../db/auth-sessions.js";
import { deriveDeviceName } from "../auth/device-name.js";
import { InMemoryTokenStore, type TokenStore } from "../auth/token-store.js";
import { logger } from "@cogni/shared";
import type { ServerDeps } from "../server.js";

type Origin = "desktop" | "web";

interface PendingLogin {
  codeVerifier: string;
  /** Post-callback URL to send the user back to (with token attached). */
  redirect: string;
  /** Where the login attempt originated; controls callback redirect_uri + how the token is delivered. */
  origin: Origin;
  /** The exact redirect_uri Google was given in the auth request. Token exchange MUST repeat the same value. */
  redirectUri: string;
}

const DEFAULT_REDIRECT = "cogni://auth";

/**
 * Only the desktop app's `cogni://` deep-link scheme is an allowed post-login
 * redirect target. The session token is appended to this URL, so an open
 * redirect here would leak credentials — anything else falls back to the default.
 */
export function safeRedirect(raw: string | undefined): string {
  if (!raw) return DEFAULT_REDIRECT;
  try {
    return new URL(raw).protocol === "cogni:" ? raw : DEFAULT_REDIRECT;
  } catch {
    return DEFAULT_REDIRECT;
  }
}

function readOrigin(raw: string | undefined): Origin {
  return raw === "web" ? "web" : "desktop";
}

/** Per-origin redirect_uri the cloud uses with Google. Must be pre-registered in GCP. */
function callbackUriFor(deps: ServerDeps, origin: Origin): string {
  return origin === "web"
    ? `${deps.webUrl}/auth/google/callback`
    : `${deps.publicUrl}/auth/google/callback`;
}

export function registerAuthRoutes(app: Hono, deps: ServerDeps): void {
  // SP-2+1: swap InMemoryTokenStore for a Redis-backed impl so an OAuth state
  // issued on node A can be redeemed on node B. The interface is identical;
  // routes/email.ts already does the same pattern for magic-link tokens.
  const TTL_MS = 10 * 60 * 1000;
  const pending: TokenStore<PendingLogin> = new InMemoryTokenStore<PendingLogin>({ ttlMs: TTL_MS });
  // Belt-and-braces sweep for entries that were never `get`'d (InMemoryTokenStore
  // evicts on access; this catches abandoned states).
  setInterval(() => { void pending.sweep(); }, 5 * 60_000).unref();

  // Dev-only: signs a JWT for a stand-in user, bypassing Google OAuth.
  // Refuses to register in production. Used by the desktop dev fallback in
  // apps/desktop/src/useAuth.ts. SP-2: also creates an auth_sessions row so
  // the JWT carries a real sessionId and the WS handshake's revocation check
  // can find it.
  if (process.env.NODE_ENV !== "production") {
    app.post("/auth/dev-token", async (c) => {
      const user = await findOrCreateUserByEmail(deps.db, "dev-manual@local.test");
      await upsertIdentity(deps.db, user.id, "dev", "manual");
      const session = await createAuthSession(deps.db, {
        userId: user.id,
        deviceName: "Desktop App (dev)",
      });
      const token = await deps.auth.issueToken({
        userId: user.id,
        tenantId: user.tenantId,
        sessionId: session.id,
      });
      return c.json({ token });
    });
  }

  // Two callers:
  //   • desktop: opens this in the system browser with ?redirect=cogni://auth (and origin=desktop by default)
  //   • web:    redirects user here with ?origin=web; cloud sends them to the web SPA's /chat afterwards
  app.get("/auth/google/start", async (c) => {
    const origin = readOrigin(c.req.query("origin"));
    const redirect = origin === "web" ? `${deps.webUrl}/chat` : safeRedirect(c.req.query("redirect"));
    const redirectUri = callbackUriFor(deps, origin);
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    await pending.set(state, { codeVerifier, redirect, origin, redirectUri });
    const google = deps.auth.makeGoogle(redirectUri);
    const url = google.createAuthorizationURL(state, codeVerifier, ["openid", "email"]);
    return c.redirect(url.toString());
  });

  app.get("/auth/google/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.text("missing code/state", 400);
    // TokenStore.get handles expiration; null means unknown OR expired.
    const entry = await pending.get(state);
    if (!entry) return c.text("unknown or expired state", 400);
    await pending.delete(state);

    try {
      const google = deps.auth.makeGoogle(entry.redirectUri);
      const tokens = await google.validateAuthorizationCode(code, entry.codeVerifier);
      const claims = decodeIdToken(tokens.idToken()) as { sub?: unknown; email?: unknown };
      if (typeof claims.sub !== "string") return c.text("invalid id token", 400);
      const sub = claims.sub;
      const email = typeof claims.email === "string" ? claims.email : `${sub}@google`;
      if (typeof claims.email !== "string") {
        logger.warn({ sub }, "google id token had no email claim; using fallback");
      }
      // SP-2: auto-merge by verified email if the user already exists under
      // another provider (e.g. magic-link).
      const user = await findOrLinkUser(deps.db, { kind: "google", sub, email });
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
      // Web origin: deliver token in URL fragment so it doesn't end up in
      // nginx access logs. Desktop origin: query param into cogni:// deep link.
      const target = new URL(entry.redirect);
      if (entry.origin === "web") target.hash = `token=${token}`;
      else target.searchParams.set("token", token);
      return c.redirect(target.toString());
    } catch (err) {
      logger.warn({ err: String(err) }, "google oauth callback failed");
      return c.text("authentication failed", 400);
    }
  });
}
