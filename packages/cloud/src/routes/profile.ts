import type { Hono } from "hono";
import { z } from "zod";
import { getUserProfile, setUserProfile } from "../db/users.js";
import type { ServerDeps } from "../server.js";

/**
 * Settings → Account profile backend: the long-promised `/api/me`.
 *
 * Auth precondition: relies on the `/api/*` Bearer-JWT middleware in
 * routes/client.ts having validated the token and stashed claims on the
 * context (`c.get("claims")`) — same as routes/identities.ts. Mounted AFTER
 * registerClientRoutes in server.ts so it inherits that middleware.
 *
 * User-visible behavior:
 *   • GET feeds the sidebar footer + Account page (name + avatar).
 *   • PATCH name → inline-rename save; PATCH avatar → after cropping/upload.
 *   • Sending name "" / null resets to the email-prefix default; avatar null
 *     resets to the first-letter circle.
 */

const AVATAR_MAX_BYTES = 256 * 1024;
const AVATAR_RE = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

/** True if `s` is a png/jpeg/webp data URL whose decoded size is within the cap. */
export function isValidAvatar(s: string): boolean {
  const m = AVATAR_RE.exec(s);
  if (!m) return false;
  const b64 = m[1]!;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((b64.length * 3) / 4) - pad;
  return bytes > 0 && bytes <= AVATAR_MAX_BYTES;
}

const patchSchema = z.object({
  name: z.string().max(50).nullable().optional(),
  avatar: z.string().nullable().optional(),
});

export function registerProfileRoutes(app: Hono, deps: ServerDeps): void {
  app.get("/api/me", async (c) => {
    const { userId } = c.get("claims");
    const profile = await getUserProfile(deps.db, userId);
    if (!profile) return c.json({ error: "not found" }, 404);
    return c.json(profile);
  });

  app.patch("/api/me", async (c) => {
    const { userId } = c.get("claims");
    const body = await c.req.json().catch(() => null);
    if (body === null || typeof body !== "object") return c.json({ error: "invalid body" }, 400);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);

    const fields: { name?: string | null; avatar?: string | null } = {};

    if (Object.prototype.hasOwnProperty.call(body, "name")) {
      const trimmed = (parsed.data.name ?? "").trim();
      fields.name = trimmed.length === 0 ? null : trimmed;
    }
    if (Object.prototype.hasOwnProperty.call(body, "avatar")) {
      const a = parsed.data.avatar;
      if (a != null && !isValidAvatar(a)) return c.json({ error: "invalid avatar" }, 400);
      fields.avatar = a ?? null;
    }

    await setUserProfile(deps.db, userId, fields);
    const updated = await getUserProfile(deps.db, userId);
    return c.json(updated);
  });
}
