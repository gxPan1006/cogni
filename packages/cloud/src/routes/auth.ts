import type { Hono } from "hono";
import { generateState, generateCodeVerifier, decodeIdToken } from "arctic";
import { findOrCreateUser } from "../db/users.js";
import { logger } from "@cogni/shared";
import type { ServerDeps } from "../server.js";

interface PendingLogin { codeVerifier: string; redirect: string; createdAt: number }

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

export function registerAuthRoutes(app: Hono, deps: ServerDeps): void {
  // SP-1: single-node in-memory state store. SP-2 moves this to a shared store.
  const pending = new Map<string, PendingLogin>();
  const TTL_MS = 10 * 60 * 1000;
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.createdAt > TTL_MS) pending.delete(k);
  };

  // Dev-only: signs a JWT for a stand-in user, bypassing Google OAuth.
  // Refuses to register in production. Used by the desktop dev fallback in
  // apps/desktop/src/useAuth.ts when the user has no localStorage token —
  // makes dogfood instant on networks where Google OAuth is unreachable
  // (e.g. flaky GFW). Mirrors the standalone packages/cloud/src/scripts/
  // mint-dev-token.ts but over HTTP so the desktop can self-serve.
  if (process.env.NODE_ENV !== "production") {
    app.post("/auth/dev-token", async (c) => {
      const user = await findOrCreateUser(deps.db, {
        oauthSub: "dev|manual",
        email: "dev-manual@local.test",
      });
      const token = await deps.auth.issueToken({
        userId: user.id,
        tenantId: user.tenantId,
      });
      return c.json({ token });
    });
  }

  // Desktop app opens this in the system browser with ?redirect=cogni://auth
  app.get("/auth/google/start", (c) => {
    sweep();
    const redirect = safeRedirect(c.req.query("redirect"));
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    pending.set(state, { codeVerifier, redirect, createdAt: Date.now() });
    const url = deps.auth.google.createAuthorizationURL(state, codeVerifier, ["openid", "email"]);
    return c.redirect(url.toString());
  });

  app.get("/auth/google/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.text("missing code/state", 400);
    const entry = pending.get(state);
    if (!entry) return c.text("unknown or expired state", 400);
    pending.delete(state);

    try {
      const tokens = await deps.auth.google.validateAuthorizationCode(code, entry.codeVerifier);
      const claims = decodeIdToken(tokens.idToken()) as { sub?: unknown; email?: unknown };
      if (typeof claims.sub !== "string") return c.text("invalid id token", 400);
      const sub = claims.sub;
      const email = typeof claims.email === "string" ? claims.email : `${sub}@google`;
      if (typeof claims.email !== "string") {
        logger.warn({ sub }, "google id token had no email claim; using fallback");
      }
      const user = await findOrCreateUser(deps.db, { oauthSub: `google|${sub}`, email });
      const token = await deps.auth.issueToken({ userId: user.id, tenantId: user.tenantId });
      const target = new URL(entry.redirect);
      target.searchParams.set("token", token);
      return c.redirect(target.toString());
    } catch (err) {
      logger.warn({ err: String(err) }, "google oauth callback failed");
      return c.text("authentication failed", 400);
    }
  });
}
