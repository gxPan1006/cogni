# User Profile Editing (Avatar + Display Name) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user edit their display name and upload/crop an avatar from Settings → Account, persisted in the cloud database and reflected in the sidebar + account page.

**Architecture:** Add `name` + `avatar` columns to the `users` table (avatar stored as a `data:` URL string, no object storage). New `GET/PATCH /api/me` cloud routes (mounted alongside the other `/api/*` settings routes so they inherit the Bearer-JWT middleware). A new `useMe()` hook fetches the profile; a shared `<Avatar>` component renders the image-or-letter fallback; a hand-rolled zero-dependency `<AvatarCropper>` does interactive crop → 256×256 webp/jpeg export. The web `App.tsx` and desktop `Shell.tsx` overlay the fetched profile onto the JWT-derived `user` object.

**Tech Stack:** Hono + drizzle + zod (cloud), React 19 + react-i18next (UI), vitest + pglite (tests). Spec: `docs/superpowers/specs/2026-05-21-user-profile-editing-design.md`.

---

## File Structure

**Cloud (`packages/cloud/src/`):**
- `db/schema.ts` — MODIFY: add `name`, `avatar` columns to `users`.
- `db/users.ts` — MODIFY: add `UserProfile` type + `getUserProfile` + `setUserProfile`.
- `routes/profile.ts` — CREATE: `GET/PATCH /api/me` + inline avatar validation.
- `routes/profile.test.ts` — CREATE: route tests (pglite).
- `scripts/migrate-2026-05-21-user-profile.ts` — CREATE: idempotent `ALTER TABLE`.
- `server.ts` — MODIFY: register the new routes.

**UI (`packages/ui/src/`):**
- `transport/api.ts` — MODIFY: `UserProfile` type + `getMe` / `updateProfile`.
- `hooks/useMe.ts` — CREATE: fetch + update profile hook.
- `lib/avatar-crop.ts` — CREATE: pure crop-math helpers.
- `lib/avatar-crop.test.ts` — CREATE: crop-math unit tests.
- `components/Avatar.tsx` — CREATE: shared image-or-letter avatar.
- `components/AvatarCropper.tsx` — CREATE: interactive cropper modal.
- `components/avatar.css` — CREATE: avatar + cropper styles.
- `components/SettingsPage.tsx` — MODIFY: wire rename + avatar in `AccountPage`; widen `user` prop type.
- `components/Sidebar.tsx` — MODIFY: render `<Avatar>`; widen `user` prop type.
- `index.ts` — MODIFY: export `Avatar` if not already surfaced (check first).
- `i18n/locales/en/settings.ts` + `i18n/locales/zh/settings.ts` — MODIFY: new account strings.

**Apps:**
- `apps/web/src/App.tsx` — MODIFY: overlay `useMe` profile onto `user`.
- `apps/desktop/src/Shell.tsx` — MODIFY: overlay `useMe` profile onto `user`.

---

## Task 1: DB schema, migration, and profile helpers

**Files:**
- Modify: `packages/cloud/src/db/schema.ts:9-20`
- Modify: `packages/cloud/src/db/users.ts`
- Create: `packages/cloud/src/scripts/migrate-2026-05-21-user-profile.ts`

- [ ] **Step 1: Add the columns to the schema**

In `packages/cloud/src/db/schema.ts`, add two nullable columns to the `users` table (after `passwordHash`, before `createdAt`):

```ts
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  // Editable display name. Null → client falls back to the email local-part.
  name: text("name"),
  // Avatar as a `data:image/<png|jpeg|webp>;base64,…` URL. Null → letter circle.
  // Stored inline (no object storage); a 256px cropped+compressed image is small.
  avatar: text("avatar"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

- [ ] **Step 2: Add the profile DB helpers**

In `packages/cloud/src/db/users.ts`, add after `setUserPassword` (end of file). Note `users` and `eq` are already imported at the top:

```ts
export interface UserProfile { email: string; name: string | null; avatar: string | null; }

/** Read the profile fields (email + editable name/avatar) for a user. */
export async function getUserProfile(
  db: AnyDb, userId: string,
): Promise<UserProfile | undefined> {
  const rows = await db
    .select({ email: users.email, name: users.name, avatar: users.avatar })
    .from(users).where(eq(users.id, userId)).limit(1);
  const u = rows[0];
  if (!u) return undefined;
  return { email: u.email, name: u.name, avatar: u.avatar };
}

/**
 * Partial update of name/avatar. Only the keys present in `fields` are written
 * (so PATCHing just the name leaves the avatar untouched). `null` clears a
 * field back to its default (email-prefix name / letter avatar).
 */
export async function setUserProfile(
  db: AnyDb, userId: string,
  fields: { name?: string | null; avatar?: string | null },
): Promise<void> {
  const patch: { name?: string | null; avatar?: string | null } = {};
  if ("name" in fields) patch.name = fields.name ?? null;
  if ("avatar" in fields) patch.avatar = fields.avatar ?? null;
  if (Object.keys(patch).length === 0) return;
  await db.update(users).set(patch).where(eq(users.id, userId));
}
```

- [ ] **Step 3: Write the migration script**

Create `packages/cloud/src/scripts/migrate-2026-05-21-user-profile.ts`:

```ts
/**
 * User profile editing migration: add the editable name + avatar columns.
 *
 * Idempotent — ADD COLUMN IF NOT EXISTS. Safe to re-run.
 *
 * Schema delta:
 *   • users: add name text (null = fall back to email local-part)
 *   • users: add avatar text (data: URL; null = letter-circle avatar)
 *
 * Run BEFORE restarting cogni-cloud with the profile routes (GET/PATCH /api/me
 * SELECT/UPDATE these columns).
 *
 * Run with:
 *   pnpm --filter @cogni/cloud exec tsx --env-file=.env \
 *     src/scripts/migrate-2026-05-21-user-profile.ts
 */
import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../env.js";

const env = loadEnv();
const sql = neon(env.databaseUrl);

console.log("[migrate] adding users.name + users.avatar columns…");
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS name text`;
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar text`;

const post = await sql`
  SELECT
    (SELECT count(*)::int FROM users) AS users_n,
    (SELECT count(*)::int FROM users WHERE name IS NOT NULL) AS with_name_n,
    (SELECT count(*)::int FROM users WHERE avatar IS NOT NULL) AS with_avatar_n
`;
console.log(`[migrate] done — users=${post[0]?.users_n}, with_name=${post[0]?.with_name_n}, with_avatar=${post[0]?.with_avatar_n}`);
process.exit(0);
```

- [ ] **Step 4: Build to verify schema + helpers compile**

Run: `pnpm --filter @cogni/cloud build`
Expected: PASS (no type errors). pglite test DBs are created from the drizzle schema, so the new columns exist automatically in tests — no migration needed there.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/db/schema.ts packages/cloud/src/db/users.ts packages/cloud/src/scripts/migrate-2026-05-21-user-profile.ts
git commit -m "feat(cloud): add users.name + users.avatar columns and profile helpers"
```

---

## Task 2: `GET/PATCH /api/me` routes + tests

**Files:**
- Create: `packages/cloud/src/routes/profile.ts`
- Create: `packages/cloud/src/routes/profile.test.ts`
- Modify: `packages/cloud/src/server.ts:111`

- [ ] **Step 1: Write the failing test**

Create `packages/cloud/src/routes/profile.test.ts`. This mirrors `routes/identities.test.ts` exactly for the test-server harness:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { makeTestDb } from "../db/test-db.js";
import { findOrCreateUserByEmail } from "../db/users.js";
import { createAuthSession, getAuthSession } from "../db/auth-sessions.js";
import { makeAuth, type SessionClaims } from "../auth.js";
import { registerProfileRoutes } from "./profile.js";
import type { ServerDeps } from "../server.js";

async function makeTestServer() {
  const { db, close } = await makeTestDb();
  const auth = makeAuth({
    jwtSecret: "test-secret-test-secret-test-sec",
    google: { clientId: "x", clientSecret: "y", redirectUri: "http://x/cb" },
  });

  const app = new Hono<{ Variables: { claims: SessionClaims } }>();
  app.use("/api/*", async (c, next) => {
    const authHeader = c.req.header("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const claims = token ? await auth.verifyToken(token) : null;
    if (!claims) return c.json({ error: "unauthorized" }, 401);
    const session = await getAuthSession(db, claims.sessionId);
    if (!session || session.revokedAt !== null) return c.json({ error: "unauthorized" }, 401);
    c.set("claims", claims);
    await next();
  });

  const deps = { db, auth } as unknown as ServerDeps;
  registerProfileRoutes(app as unknown as Hono, deps);

  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function login(email = "alice@example.com") {
    const user = await findOrCreateUserByEmail(db, email);
    const session = await createAuthSession(db, { userId: user.id, deviceName: "test" });
    const token = await auth.issueToken({ userId: user.id, tenantId: user.tenantId, sessionId: session.id });
    return { token, userId: user.id };
  }
  async function stop() {
    await new Promise<void>((res) => server.close(() => res()));
    await close();
  }
  return { baseUrl, db, login, stop };
}

function withAuth(token: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}), Authorization: `Bearer ${token}` } };
}

// A tiny valid PNG data URL (1×1) — well under the size cap.
const SMALL_AVATAR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("profile routes", () => {
  let s: Awaited<ReturnType<typeof makeTestServer>>;
  beforeEach(async () => { s = await makeTestServer(); });
  afterEach(async () => { await s.stop(); });

  it("GET /api/me returns email with null name/avatar for a fresh user", async () => {
    const { token } = await s.login();
    const res = await fetch(`${s.baseUrl}/api/me`, withAuth(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "alice@example.com", name: null, avatar: null });
  });

  it("requires auth (401 without Bearer)", async () => {
    const res = await fetch(`${s.baseUrl}/api/me`);
    expect(res.status).toBe(401);
  });

  it("PATCH name updates it and GET reflects it", async () => {
    const { token } = await s.login();
    const res = await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ name: "  Alice Liddell  " }) }));
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("Alice Liddell"); // trimmed
    const after = await (await fetch(`${s.baseUrl}/api/me`, withAuth(token))).json();
    expect(after.name).toBe("Alice Liddell");
  });

  it("PATCH rejects a name longer than 50 chars (400)", async () => {
    const { token } = await s.login();
    const res = await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ name: "x".repeat(51) }) }));
    expect(res.status).toBe(400);
  });

  it("PATCH empty/whitespace name clears it to null", async () => {
    const { token } = await s.login();
    await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ name: "Bob" }) }));
    const res = await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ name: "   " }) }));
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBeNull();
  });

  it("PATCH a valid small avatar stores it; null clears it", async () => {
    const { token } = await s.login();
    const set = await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ avatar: SMALL_AVATAR }) }));
    expect(set.status).toBe(200);
    expect((await set.json()).avatar).toBe(SMALL_AVATAR);
    const cleared = await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ avatar: null }) }));
    expect((await cleared.json()).avatar).toBeNull();
  });

  it("PATCH rejects a non-image / wrong-mime avatar (400)", async () => {
    const { token } = await s.login();
    const res = await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ avatar: "data:text/plain;base64,aGVsbG8=" }) }));
    expect(res.status).toBe(400);
  });

  it("PATCH rejects an oversize avatar (>256KB) (400)", async () => {
    const { token } = await s.login();
    // ~360k base64 chars ≈ 270KB decoded — over the 256KB cap.
    const big = "data:image/png;base64," + "A".repeat(360_000);
    const res = await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ avatar: big }) }));
    expect(res.status).toBe(400);
  });

  it("PATCH leaves avatar untouched when only name is sent", async () => {
    const { token } = await s.login();
    await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ avatar: SMALL_AVATAR }) }));
    await fetch(`${s.baseUrl}/api/me`, withAuth(token, { method: "PATCH", body: JSON.stringify({ name: "Carol" }) }));
    const after = await (await fetch(`${s.baseUrl}/api/me`, withAuth(token))).json();
    expect(after).toEqual({ email: "alice@example.com", name: "Carol", avatar: SMALL_AVATAR });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/cloud/src/routes/profile.test.ts`
Expected: FAIL — `Cannot find module './profile.js'` (route file not created yet).

- [ ] **Step 3: Write the route implementation**

Create `packages/cloud/src/routes/profile.ts`:

```ts
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
```

- [ ] **Step 4: Register the routes in server.ts**

In `packages/cloud/src/server.ts`, add the import near the other route imports and register it right after `registerIdentitiesRoutes(app, deps);` (line ~111):

```ts
import { registerProfileRoutes } from "./routes/profile.js";
```
```ts
  registerIdentitiesRoutes(app, deps);
  registerProfileRoutes(app, deps);          // GET/PATCH /api/me — same /api/* Bearer middleware
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/cloud/src/routes/profile.test.ts`
Expected: PASS (all 9 tests green).

- [ ] **Step 6: Commit**

```bash
git add packages/cloud/src/routes/profile.ts packages/cloud/src/routes/profile.test.ts packages/cloud/src/server.ts
git commit -m "feat(cloud): GET/PATCH /api/me profile routes with avatar validation"
```

---

## Task 3: ApiClient `getMe` / `updateProfile`

**Files:**
- Modify: `packages/ui/src/transport/api.ts` (type block near line 97; methods after the Identities block ~line 258)

- [ ] **Step 1: Add the `UserProfile` type**

In `packages/ui/src/transport/api.ts`, after the `IdentityRow` interface (line 101):

```ts
export interface UserProfile {
  email: string;
  name: string | null;
  avatar: string | null;
}
```

- [ ] **Step 2: Add the client methods**

After the Identities section (after `deleteIdentity`, ~line 258), add:

```ts
  // ─── Profile (/api/me) ────────────────────────────────────────────────
  getMe = (): Promise<UserProfile> =>
    this.request(`${this.cloudUrl}/api/me`, { headers: this.authHeaders() });

  /** Partial update — only the keys present are written. `null` clears a field. */
  updateProfile = (patch: { name?: string | null; avatar?: string | null }): Promise<UserProfile> =>
    this.request(`${this.cloudUrl}/api/me`, {
      method: "PATCH", headers: this.authHeaders(), body: JSON.stringify(patch),
    });
```

- [ ] **Step 3: Build to verify it compiles**

Run: `pnpm --filter @cogni/ui exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/transport/api.ts
git commit -m "feat(ui): ApiClient getMe + updateProfile"
```

---

## Task 4: `useMe` hook

**Files:**
- Create: `packages/ui/src/hooks/useMe.ts`

- [ ] **Step 1: Write the hook**

Create `packages/ui/src/hooks/useMe.ts` (mirrors `useIdentities.ts`):

```ts
import { useCallback, useEffect, useState } from "react";
import type { ApiClient, UserProfile } from "../transport/api.js";

/**
 * Loads the signed-in user's editable profile (name + avatar) from `/api/me`.
 *
 * UI behaviour: the sidebar / account page paint instantly from the
 * JWT-derived email; this hook fetches the real name/avatar a moment later and
 * the host overlays it (no visible reload). `update` PATCHes then refreshes so
 * the new name/avatar appears everywhere bound to this client.
 */
export function useMe(api: ApiClient) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setProfile(await api.getMe());
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  const update = useCallback(async (patch: { name?: string | null; avatar?: string | null }) => {
    const next = await api.updateProfile(patch);
    setProfile(next);
    return next;
  }, [api]);

  return { profile, loading, refresh, update };
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `pnpm --filter @cogni/ui exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/hooks/useMe.ts
git commit -m "feat(ui): useMe hook for /api/me profile"
```

---

## Task 5: Avatar crop math (pure helpers + tests)

**Files:**
- Create: `packages/ui/src/lib/avatar-crop.ts`
- Create: `packages/ui/src/lib/avatar-crop.test.ts`

Model: the cropper shows the image inside a square viewport of `viewport` CSS px. `displayScale` = screen px per source px = `(viewport / min(natW,natH)) * zoom` (zoom ≥ 1, so the image always covers the viewport at zoom 1). The image's top-left sits at `(offsetX, offsetY)` screen px relative to the viewport's top-left (both ≤ 0). The exported square maps the viewport region back to source pixels.

- [ ] **Step 1: Write the failing test**

Create `packages/ui/src/lib/avatar-crop.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { displayScale, clampOffset, sourceRect } from "./avatar-crop.js";

describe("avatar-crop math", () => {
  it("displayScale covers the viewport at zoom 1 using the shorter side", () => {
    // 1000×500 image into a 250px viewport: shorter side = 500 → 250/500 = 0.5
    expect(displayScale(1000, 500, 250, 1)).toBeCloseTo(0.5);
    expect(displayScale(1000, 500, 250, 2)).toBeCloseTo(1.0);
  });

  it("clampOffset keeps the viewport fully covered (offsets in [viewport - disp, 0])", () => {
    // disp size at scale 0.5: 1000*0.5=500 wide, 500*0.5=250 tall, viewport 250
    const scale = 0.5;
    // x can range [250-500, 0] = [-250, 0]; y range [250-250,0] = [0,0]
    expect(clampOffset(-1000, 1000, 500, 250, scale)).toBe(-250); // clamp low
    expect(clampOffset(100, 1000, 500, 250, scale)).toBe(0);      // clamp high
    expect(clampOffset(-100, 1000, 500, 250, scale)).toBe(-100);  // within range
    expect(clampOffset(50, 1000, 500, 250, scale)).toBe(0);       // y fully pinned
  });

  it("sourceRect maps the viewport square back to source pixels", () => {
    // square image 500×500, viewport 250, zoom 1 → scale 0.5, offset 0,0
    // viewport covers source [0,0]..[500,500]
    const r = sourceRect(500, 500, 250, 0.5, 0, 0);
    expect(r).toEqual({ sx: 0, sy: 0, sw: 500, sh: 500 });
  });

  it("sourceRect shifts the source origin when panned", () => {
    // offsetX -125 px at scale 0.5 → source x starts at 250
    const r = sourceRect(1000, 500, 250, 0.5, -125, 0);
    expect(r.sx).toBeCloseTo(250);
    expect(r.sw).toBeCloseTo(500);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/ui/src/lib/avatar-crop.test.ts`
Expected: FAIL — `Cannot find module './avatar-crop.js'`.

- [ ] **Step 3: Write the helpers**

Create `packages/ui/src/lib/avatar-crop.ts`:

```ts
/**
 * Pure crop-math for the avatar cropper. No DOM/canvas here so it's unit
 * testable; AvatarCropper.tsx feeds these results into a canvas drawImage.
 *
 * Coordinate model: a square `viewport` (CSS px). The source image is drawn at
 * `displayScale` screen px per source px, with its top-left at (offsetX,
 * offsetY) screen px relative to the viewport's top-left. At zoom 1 the image
 * exactly covers the viewport along its shorter side; zoom > 1 magnifies.
 */

/** Screen px per source px so the image covers the viewport along its shorter side, times zoom. */
export function displayScale(natW: number, natH: number, viewport: number, zoom: number): number {
  return (viewport / Math.min(natW, natH)) * zoom;
}

/**
 * Clamp one offset axis so the (scaled) image always fully covers the viewport.
 * `coord` is the proposed offset (≤ 0); `dispLen = natLen * scale`. Returns the
 * offset clamped to [viewport - dispLen, 0] (or 0 if the image is smaller).
 */
export function clampOffset(coord: number, natW: number, natH: number, viewport: number, scale: number): number {
  // natW/natH passed for symmetry with sourceRect callers; per-axis length is
  // chosen by the caller via which dimension it maps. Here we treat natW as the
  // axis length being clamped.
  const dispLen = natW * scale;
  const min = Math.min(0, viewport - dispLen);
  if (coord > 0) return 0;
  if (coord < min) return min;
  return coord;
}

/** Map the square viewport back to a source-pixel rectangle for ctx.drawImage. */
export function sourceRect(
  natW: number, natH: number, viewport: number, scale: number, offsetX: number, offsetY: number,
): { sx: number; sy: number; sw: number; sh: number } {
  void natW; void natH;
  const span = viewport / scale;
  return { sx: -offsetX / scale, sy: -offsetY / scale, sw: span, sh: span };
}
```

> NOTE for the implementer: in the test `clampOffset(-1000, 1000, 500, …)` the second arg (`natW=1000`) is the axis length being clamped (image width). For the Y axis the caller passes the image height as the second arg. Keep `clampOffset(coord, axisNatLen, _otherNat, viewport, scale)` — the third arg is unused; it exists only so call sites read symmetrically. If you prefer, simplify the signature to `clampOffset(coord, axisNatLen, viewport, scale)` and update both the test and call sites to match. Pick one and make the test agree.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/ui/src/lib/avatar-crop.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/avatar-crop.ts packages/ui/src/lib/avatar-crop.test.ts
git commit -m "feat(ui): pure avatar crop-math helpers"
```

---

## Task 6: Shared `<Avatar>` component

**Files:**
- Create: `packages/ui/src/components/Avatar.tsx`
- Create: `packages/ui/src/components/avatar.css`

- [ ] **Step 1: Write the component**

Create `packages/ui/src/components/Avatar.tsx`:

```tsx
import "./avatar.css";

/**
 * User avatar: renders the uploaded image when present, else a colored circle
 * with the name's first letter. One place for the fallback so the sidebar
 * footer and the Account page stay in sync.
 *
 * `size` is the diameter in px (sidebar uses 26, Account uses 32+). The letter
 * scales to ~half the diameter.
 */
export function Avatar({ name, avatar, size = 26, className }: {
  name: string;
  avatar?: string | null;
  size?: number;
  className?: string;
}) {
  const cls = "avatar" + (className ? " " + className : "");
  if (avatar) {
    return <img className={cls} src={avatar} alt={name} width={size} height={size} style={{ width: size, height: size }} />;
  }
  const initial = (name.slice(0, 1) || "?").toUpperCase();
  return (
    <span className={cls} style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}>
      {initial}
    </span>
  );
}
```

- [ ] **Step 2: Write the CSS**

Create `packages/ui/src/components/avatar.css`:

```css
.avatar {
  border-radius: 50%;
  flex-shrink: 0;
  object-fit: cover;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: oklch(98% 0.01 80);
  font-family: var(--font-sans);
  font-weight: 600;
  line-height: 1;
}
img.avatar { background: var(--surface-2, transparent); }
```

- [ ] **Step 3: Export it from the package index (if components are re-exported there)**

Check `packages/ui/src/index.ts` for how `SettingsPage` / `Sidebar` are exported. If components are re-exported, add `export { Avatar } from "./components/Avatar.js";` alongside them. If apps import components by deep path instead, skip this step.

Run: `grep -n "SettingsPage\|Sidebar" packages/ui/src/index.ts`
Expected: shows the existing export style to match.

- [ ] **Step 4: Build to verify it compiles**

Run: `pnpm --filter @cogni/ui exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/Avatar.tsx packages/ui/src/components/avatar.css packages/ui/src/index.ts
git commit -m "feat(ui): shared Avatar component (image-or-letter)"
```

---

## Task 7: Interactive `<AvatarCropper>`

**Files:**
- Create: `packages/ui/src/components/AvatarCropper.tsx`
- Modify: `packages/ui/src/components/avatar.css` (append cropper styles)

- [ ] **Step 1: Write the cropper component**

Create `packages/ui/src/components/AvatarCropper.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { displayScale, clampOffset, sourceRect } from "../lib/avatar-crop.js";

const VIEWPORT = 256;     // on-screen crop square (CSS px)
const OUT = 256;          // exported avatar size (px)
const MAX_ZOOM = 4;

/**
 * Modal cropper: shows the picked image in a 256px square, drag to pan,
 * scroll / pinch to zoom (zoom ≥ 1 so the square is always covered). On
 * confirm it draws the cropped region to a 256×256 canvas and exports webp
 * (jpeg fallback where webp export is unsupported), handing the data URL to
 * `onConfirm`.
 */
export function AvatarCropper({ file, onConfirm, onCancel }: {
  file: File;
  onConfirm: (dataUrl: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  // Load the picked file into an Image, recentre when it (or zoom) changes.
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => setImg(im);
    im.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!img) return;
    const scale = displayScale(img.naturalWidth, img.naturalHeight, VIEWPORT, zoom);
    // Centre the image in the viewport.
    const cx = (VIEWPORT - img.naturalWidth * scale) / 2;
    const cy = (VIEWPORT - img.naturalHeight * scale) / 2;
    setOffset({
      x: clampOffset(cx, img.naturalWidth, img.naturalHeight, VIEWPORT, scale),
      y: clampOffset(cy, img.naturalHeight, img.naturalWidth, VIEWPORT, scale),
    });
  }, [img, zoom]);

  if (!img) return null;
  const scale = displayScale(img.naturalWidth, img.naturalHeight, VIEWPORT, zoom);
  const dispW = img.naturalWidth * scale;
  const dispH = img.naturalHeight * scale;

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const nx = drag.current.ox + (e.clientX - drag.current.px);
    const ny = drag.current.oy + (e.clientY - drag.current.py);
    setOffset({
      x: clampOffset(nx, img.naturalWidth, img.naturalHeight, VIEWPORT, scale),
      y: clampOffset(ny, img.naturalHeight, img.naturalWidth, VIEWPORT, scale),
    });
  };
  const onPointerUp = () => { drag.current = null; };

  const confirm = () => {
    const canvas = document.createElement("canvas");
    canvas.width = OUT; canvas.height = OUT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const r = sourceRect(img.naturalWidth, img.naturalHeight, VIEWPORT, scale, offset.x, offset.y);
    ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, 0, 0, OUT, OUT);
    let url = canvas.toDataURL("image/webp", 0.85);
    if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/jpeg", 0.85);
    onConfirm(url);
  };

  return (
    <div className="cropper__backdrop" role="dialog" aria-modal="true">
      <div className="cropper">
        <div className="cropper__title">{t("settings.account.cropTitle")}</div>
        <div
          className="cropper__viewport"
          style={{ width: VIEWPORT, height: VIEWPORT }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={(e) => {
            const next = Math.min(MAX_ZOOM, Math.max(1, zoom - e.deltaY * 0.001));
            setZoom(next);
          }}
        >
          <img
            className="cropper__img"
            src={img.src}
            draggable={false}
            style={{ width: dispW, height: dispH, transform: `translate(${offset.x}px, ${offset.y}px)` }}
            alt=""
          />
          <div className="cropper__ring" />
        </div>
        <input
          className="cropper__zoom"
          type="range" min={1} max={MAX_ZOOM} step={0.01}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          aria-label={t("settings.account.cropZoom")}
        />
        <div className="cropper__actions">
          <button className="btn btn-sm btn-ghost" onClick={onCancel}>{t("settings.account.cropCancel")}</button>
          <button className="btn btn-sm" onClick={confirm}>{t("settings.account.cropSave")}</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append cropper styles**

Append to `packages/ui/src/components/avatar.css`:

```css
.cropper__backdrop {
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  background: oklch(0% 0 0 / 0.5);
}
.cropper {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 12px; padding: 16px; display: flex;
  flex-direction: column; gap: 12px; align-items: stretch;
}
.cropper__title { font-weight: 600; font-size: 14px; }
.cropper__viewport {
  position: relative; overflow: hidden; border-radius: 50%;
  touch-action: none; cursor: grab; user-select: none;
  background: var(--surface-2, #0002);
}
.cropper__viewport:active { cursor: grabbing; }
.cropper__img { position: absolute; top: 0; left: 0; max-width: none; pointer-events: none; }
.cropper__ring { position: absolute; inset: 0; border-radius: 50%; box-shadow: 0 0 0 2px var(--accent) inset; pointer-events: none; }
.cropper__zoom { width: 100%; }
.cropper__actions { display: flex; justify-content: flex-end; gap: 8px; }
```

- [ ] **Step 3: Build to verify it compiles**

Run: `pnpm --filter @cogni/ui exec tsc --noEmit`
Expected: PASS. (i18n keys referenced here are added in Task 8 — `tsc` doesn't check translation keys, so this passes now.)

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/AvatarCropper.tsx packages/ui/src/components/avatar.css
git commit -m "feat(ui): interactive AvatarCropper (drag/zoom → 256px webp)"
```

---

## Task 8: i18n strings + wire `AccountPage`

**Files:**
- Modify: `packages/ui/src/i18n/locales/en/settings.ts` (account block ~line 20-25)
- Modify: `packages/ui/src/i18n/locales/zh/settings.ts` (account block ~line 20-25)
- Modify: `packages/ui/src/components/SettingsPage.tsx` (`AccountPage` ~line 83-138; `user` prop type ~line 27-32, 87)

- [ ] **Step 1: Add the English strings**

In `packages/ui/src/i18n/locales/en/settings.ts`, inside the `account:` object, replace the `renameDisabledTitle` line and add the new keys (keep `rename: "Rename"`):

```ts
    rename: "Rename",
    renameSave: "Save",
    renameCancel: "Cancel",
    nameTooLong: "Name must be 50 characters or fewer",
    changeAvatar: "Change photo",
    removeAvatar: "Remove photo",
    avatarTooLarge: "Image is too large — please pick a smaller one",
    avatarBadType: "Please choose a PNG, JPEG, or WebP image",
    cropTitle: "Crop your photo",
    cropZoom: "Zoom",
    cropSave: "Save",
    cropCancel: "Cancel",
```

Delete the now-unused `renameDisabledTitle` key from this file.

- [ ] **Step 2: Add the Chinese strings**

In `packages/ui/src/i18n/locales/zh/settings.ts`, inside the `account:` object (keep `rename: "改名"`), replace `renameDisabledTitle` with:

```ts
    rename: "改名",
    renameSave: "保存",
    renameCancel: "取消",
    nameTooLong: "名字不能超过 50 个字符",
    changeAvatar: "更换头像",
    removeAvatar: "移除头像",
    avatarTooLarge: "图片太大了，请选小一点的",
    avatarBadType: "请选择 PNG、JPEG 或 WebP 图片",
    cropTitle: "裁剪头像",
    cropZoom: "缩放",
    cropSave: "保存",
    cropCancel: "取消",
```

Delete the now-unused `renameDisabledTitle` key from this file.

- [ ] **Step 3: Rewrite `AccountPage` to wire rename + avatar**

In `packages/ui/src/components/SettingsPage.tsx`:

First, widen the `user` prop type in **both** `SettingsPage` (line 31) and `AccountPage` (line 87) from `{ name: string; email: string }` to `{ name: string; email: string; avatar?: string | null }`. Also update the default on line 27 to `user = { name: "you", email: "—" }` (unchanged — avatar is optional).

Add imports at the top (near the other hook imports):

```ts
import { useMe } from "../hooks/useMe.js";
import { Avatar } from "./Avatar.js";
import { AvatarCropper } from "./AvatarCropper.js";
```

Replace the `AccountPage` function body (lines 83-138) with:

```tsx
function AccountPage({
  api, user,
}: {
  api: ApiClient;
  user: { name: string; email: string; avatar?: string | null };
}) {
  const { t } = useTranslation();
  const { profile, update } = useMe(api);
  const { identities, loading, remove } = useIdentities(api);
  const canRemove = identities.length > 1;

  // Live values: prefer the freshly-fetched profile, fall back to the prop
  // (JWT-derived) until /api/me resolves.
  const displayName = profile?.name ?? user.name;
  const avatar = profile?.avatar ?? user.avatar ?? null;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName);
  const [error, setError] = useState<string | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const saveName = async () => {
    const trimmed = draft.trim();
    if (trimmed.length > 50) { setError(t("settings.account.nameTooLong")); return; }
    setError(null);
    await update({ name: trimmed });   // "" clears to email-prefix on the server
    setEditing(false);
  };

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";   // allow re-picking the same file
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { setError(t("settings.account.avatarBadType")); return; }
    setError(null);
    setCropFile(f);
  };

  const saveAvatar = async (dataUrl: string) => {
    setCropFile(null);
    try {
      await update({ avatar: dataUrl });
    } catch {
      setError(t("settings.account.avatarTooLarge"));
    }
  };

  return (
    <>
      <SectionHead title={t("settings.account.title")} subtitle={t("settings.account.subtitle")} />
      <div className="settings-card">
        <Row
          icon={
            <button
              className="settings-avatar-btn"
              onClick={() => fileRef.current?.click()}
              title={t("settings.account.changeAvatar")}
            >
              <Avatar name={displayName} avatar={avatar} size={32} />
            </button>
          }
          title={
            editing ? (
              <input
                className="settings-card__rename-input"
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveName();
                  else if (e.key === "Escape") { setEditing(false); setError(null); }
                }}
              />
            ) : displayName
          }
          sub={`${user.email} · ${t("settings.account.tenantSuffix")}`}
          right={
            editing ? (
              <div className="settings-card__row-actions">
                <button className="btn btn-sm" onClick={() => { void saveName(); }}>{t("settings.account.renameSave")}</button>
                <button className="btn btn-sm btn-ghost" onClick={() => { setEditing(false); setError(null); }}>{t("settings.account.renameCancel")}</button>
              </div>
            ) : (
              <div className="settings-card__row-actions">
                <button className="btn btn-sm btn-ghost" onClick={() => { setDraft(displayName); setEditing(true); }}>{t("settings.account.rename")}</button>
                {avatar && (
                  <button className="btn btn-sm btn-ghost" style={{ color: "var(--bad)" }} onClick={() => { void update({ avatar: null }); }}>
                    {t("settings.account.removeAvatar")}
                  </button>
                )}
              </div>
            )
          }
        />
        {error && <div className="settings-card__foot" style={{ color: "var(--bad)" }}>{error}</div>}
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={pickFile} />
      </div>

      <SectionHead title={t("settings.account.methodsTitle")} subtitle={t("settings.account.methodsSubtitle")} />
      <div className="settings-card">
        {loading && <SettingsLoading label={t("settings.account.methodsLoadingLabel")} rows={2} />}
        {!loading && identities.length === 0 && (
          <div className="settings-card__foot"><span>{t("settings.account.noMethods")}</span></div>
        )}
        {!loading && identities.map((id) => (
          <Row
            key={`${id.kind}-${id.sub}`}
            icon={<span style={{ fontSize: 14 }}>{kindIcon(id.kind)}</span>}
            title={kindLabel(id.kind, t)}
            sub={id.sub}
            right={
              <button
                className="btn btn-sm"
                disabled={!canRemove}
                title={canRemove ? t("settings.account.unbindTitle") : t("settings.account.unbindDisabledTitle")}
                onClick={() => { void remove(id.kind, id.sub); }}
              >
                {t("settings.account.unbind")}
              </button>
            }
          />
        ))}
        <div className="settings-card__foot">
          <span style={{ color: "var(--warn)" }}>{Icon.shield}</span>
          <span>{t("settings.account.keepOneMethod")}</span>
        </div>
      </div>

      {cropFile && (
        <AvatarCropper file={cropFile} onConfirm={(url) => { void saveAvatar(url); }} onCancel={() => setCropFile(null)} />
      )}
    </>
  );
}
```

Add `useRef` to the React import at the top of the file (currently `import { useState } from "react";` → `import { useState, useRef } from "react";`).

Append to `packages/ui/src/components/settings.css`:

```css
.settings-avatar-btn { background: none; border: 0; padding: 0; cursor: pointer; border-radius: 50%; }
.settings-avatar-btn:hover { opacity: 0.85; }
```

- [ ] **Step 4: Build to verify it compiles**

Run: `pnpm --filter @cogni/ui exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/SettingsPage.tsx packages/ui/src/components/settings.css packages/ui/src/i18n/locales/en/settings.ts packages/ui/src/i18n/locales/zh/settings.ts
git commit -m "feat(ui): wire Account page rename + avatar upload/crop/remove"
```

---

## Task 9: Sidebar uses `<Avatar>`

**Files:**
- Modify: `packages/ui/src/components/Sidebar.tsx` (`user` prop type line 67; render lines 90-91, 192-199)
- Modify: `packages/ui/src/components/sidebar.css:340-347` (remove the `.sb__avatar` letter-only block or leave it for the `<img>` sizing)

- [ ] **Step 1: Widen the `user` prop type**

In `packages/ui/src/components/Sidebar.tsx` line 67, change:

```ts
  user?: { name: string; email: string };
```
to
```ts
  user?: { name: string; email: string; avatar?: string | null };
```

- [ ] **Step 2: Render the shared Avatar**

Add the import near the top (with the other component imports, line ~19):

```ts
import { Avatar } from "./Avatar.js";
```

Delete line 91 (`const initial = user.name.slice(0, 1).toUpperCase();`).

Replace the avatar span in the user button (line 193) — change:

```tsx
        <span className="sb__avatar">{initial}</span>
```
to
```tsx
        <Avatar name={user.name} avatar={user.avatar} size={26} className="sb__avatar" />
```

- [ ] **Step 3: Reconcile the CSS**

In `packages/ui/src/components/sidebar.css`, the `.sb__avatar` rule (lines 340-347) now also applies to an `<img class="avatar sb__avatar">`. Replace its body with just layout that won't fight the shared `.avatar` rule:

```css
.sb__avatar {
  width: 26px; height: 26px;
}
```

(The color/letter styling now comes from `.avatar` in `avatar.css`; `object-fit: cover` there handles the image.)

- [ ] **Step 4: Build to verify it compiles**

Run: `pnpm --filter @cogni/ui exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/Sidebar.tsx packages/ui/src/components/sidebar.css
git commit -m "feat(ui): sidebar footer uses shared Avatar"
```

---

## Task 10: Overlay the fetched profile in web + desktop

**Files:**
- Modify: `apps/web/src/App.tsx` (user useMemo ~line 232-237; needs the `api` + `useMe`)
- Modify: `apps/desktop/src/Shell.tsx` (user useMemo ~line 166-173)

- [ ] **Step 1: Web — overlay `useMe` onto the `user` object**

In `apps/web/src/App.tsx`, import the hook (near other `@cogni/ui` hook imports):

```ts
import { useMe } from "@cogni/ui";
```

> Verify the export path: run `grep -n "useMe\|useIdentities" packages/ui/src/index.ts`. If hooks are exported from the package root, `import { useMe } from "@cogni/ui"` works. If `useIdentities` is imported by a deeper path in this app, match that path for `useMe` and add the export to `index.ts` if missing.

Find the `user` useMemo (lines 232-237) and replace it. It needs `api` in scope (the component already has `api`). Add the hook call near the other hooks in this component, then:

```ts
  const { profile } = useMe(api);
  const user = useMemo(() => {
    const claims = decodeJwt(token ?? "");
    const email = profile?.email ?? claims?.email;
    if (!email) return undefined;
    const name = profile?.name ?? email.split("@")[0] ?? email;
    return { name, email, avatar: profile?.avatar ?? null };
  }, [token, profile]);
```

- [ ] **Step 2: Desktop — same overlay**

In `apps/desktop/src/Shell.tsx`, import the hook (with the other `@cogni/ui` imports near line 34):

```ts
import { useMe } from "@cogni/ui";
```

Replace the `user` useMemo (lines 166-173, including the `// SP-2 will swap this for /api/me` comment) with:

```ts
  const { profile } = useMe(api);
  const user = useMemo(() => {
    const claims = decodeJwt(token);
    const email = profile?.email ?? claims?.email;
    if (!email) return undefined;
    const name = profile?.name ?? email.split("@")[0]! ;
    return { name, email, avatar: profile?.avatar ?? null };
  }, [token, profile]);
```

> `api` must be in scope here — it already is (Shell constructs/receives the ApiClient). If `useMe` requires `api` before it's defined, move the hook call below the `api` definition.

- [ ] **Step 3: Build both apps**

Run: `pnpm --filter web exec tsc --noEmit && pnpm --filter desktop exec tsc --noEmit`
Expected: PASS. (If `@cogni/ui` doesn't export `useMe`, Step 1's verification will have caught it.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/App.tsx apps/desktop/src/Shell.tsx
git commit -m "feat(web,desktop): overlay /api/me profile onto sidebar user"
```

---

## Task 11: Full verification

- [ ] **Step 1: Typecheck + test the whole repo**

Run: `pnpm build && pnpm test`
Expected: build PASS; all tests PASS (including the new `profile.test.ts` and `avatar-crop.test.ts`).

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: PASS (fix any unused-import / `noUncheckedIndexedAccess` issues introduced).

- [ ] **Step 3: Apply the DB migration to the dev database**

Run: `pnpm --filter @cogni/cloud exec tsx --env-file=.env src/scripts/migrate-2026-05-21-user-profile.ts`
Expected: `[migrate] done — users=…, with_name=0, with_avatar=0`.

- [ ] **Step 4: Manual smoke (per `CLAUDE.md` "Verifying user-visible changes")**

Kill stale processes, rebuild, then in a running client:
1. Open Settings → Account → click **Rename**, change the name, Save → sidebar footer + account row update.
2. Click the avatar → pick an image → drag/zoom in the cropper → Save → avatar appears in account + sidebar.
3. Click **Remove photo** → reverts to the letter circle.
4. Reload (Cmd+R in Tauri / browser refresh) → name + avatar persist (came from `/api/me`).
5. Try a name > 50 chars → inline error, not saved.

---

## Self-Review Notes

- **Spec coverage:** schema (T1) ✓; `GET/PATCH /api/me` + 256KB/mime guard (T2) ✓; `useMe` + first-paint overlay (T4, T10) ✓; interactive zero-dep cropper (T5, T7) ✓; activate disabled Rename + Remove avatar (T8) ✓; shared `<Avatar>` in Sidebar + Account (T6, T8, T9) ✓; i18n en/zh (T8) ✓; cloud tests (T2) ✓; migration (T1) ✓. No Google scope change (correctly absent).
- **Type consistency:** `UserProfile { email; name; avatar }` defined identically in cloud `db/users.ts` and UI `transport/api.ts`; `update`/`getMe`/`updateProfile` signatures match across hook + client + routes; crop helpers `displayScale`/`clampOffset`/`sourceRect` names match between `avatar-crop.ts`, its test, and `AvatarCropper.tsx`.
- **Known implementer decision (flagged inline in T5):** `clampOffset`'s arg order — pick the 5-arg symmetric form or the simplified 4-arg form and make the test + call sites agree. Both call sites in `AvatarCropper.tsx` (Step 1, T7) pass the per-axis natural length as the 2nd arg.
- **Open items from spec:** HTTP DTO sharing → resolved by defining types inline in `api.ts` (matches `IdentityRow`/`CreateProjectInput`), no `@cogni/contract` change. webp-vs-jpeg → resolved at runtime in `AvatarCropper.confirm()` via the `data:image/webp` prefix check.
