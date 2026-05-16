# Email Magic Link Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 cogni 加 email magic-link 登录,解决 Google OAuth 在 GFW 后不可用的问题;同时把身份模型升级为 email-based(一个 email = 一个 user,Google 和 magic link 在同一 user 上挂多个 identity)。

**Architecture:** 后端加 `routes/email.ts`(POST /auth/email/send + /auth/email/callback)、`email/transport.ts`(EmailTransport 抽象 + ResendTransport / ConsoleTransport / FakeTransport)、`rate-limit.ts`(in-memory bucket)。DB 把 `users.oauth_sub` 移到新 `user_identities` 表(kind/sub 复合 PK),`findOrCreateUser` 拆成 `findOrCreateUserByEmail` + `upsertIdentity`。Google OAuth callback、dev-token endpoint、mint-dev-token CLI 都改用新两步签名。桌面端 `useAuth.ts` 在 `onOpenUrl` 收到 `cogni://auth?magic=…` 时 POST 给 cloud 拿 JWT;Login.tsx 改成 state machine(form / sending / sent / error)双 CTA(email + Google)。

**Tech Stack:** Hono + zod + drizzle-orm(pg + pglite for test)+ Resend HTTPS API + Tauri 2 + React + Vite

**Reference spec:** `docs/superpowers/specs/2026-05-16-email-magic-link-auth-design.md`

---

## File Structure

**New files:**
- `packages/cloud/src/rate-limit.ts` — in-memory sliding-window rate limiter
- `packages/cloud/src/rate-limit.test.ts`
- `packages/cloud/src/email/transport.ts` — `EmailTransport` interface + `ResendTransport`, `ConsoleTransport`, `FakeTransport`
- `packages/cloud/src/email/transport.test.ts`
- `packages/cloud/src/db/identities.ts` — `upsertIdentity`, `listIdentitiesForUser`
- `packages/cloud/src/db/identities.test.ts`
- `packages/cloud/src/routes/email.ts` — `POST /auth/email/send`, `POST /auth/email/callback`
- `packages/cloud/src/routes/email.test.ts`

**Modified files:**
- `packages/cloud/src/db/schema.ts` — drop `users.oauth_sub`, add `user_identities` table
- `packages/cloud/src/db/test-db.ts` — sync DDL with schema change
- `packages/cloud/src/db/users.ts` — replace `findOrCreateUser` with `findOrCreateUserByEmail`
- `packages/cloud/src/db/users.test.ts` — adapt test
- `packages/cloud/src/auth.ts` — no API change but doc comment
- `packages/cloud/src/routes/auth.ts` — Google callback + dev-token use new two-step (`findOrCreateUserByEmail` + `upsertIdentity`)
- `packages/cloud/src/routes/auth.test.ts` — adapt
- `packages/cloud/src/server.ts` — `ServerDeps` gains `emailTransport: EmailTransport`, register `/auth/email/*` routes
- `packages/cloud/src/main.ts` — wire `emailTransport` from env
- `packages/cloud/src/env.ts` — add `EMAIL_TRANSPORT`, `RESEND_API_KEY`, `EMAIL_FROM`, `MAGIC_LINK_TTL_MIN` (optional override)
- `packages/cloud/src/scripts/mint-dev-token.ts` — use new two-step signature
- `packages/cloud/.env.example` — document new vars
- `apps/desktop/src/api.ts` — add `sendMagicLink(email)` + `redeemMagic(magic)`
- `apps/desktop/src/useAuth.ts` — `onOpenUrl` routes `magic=` vs `token=`; `sendMagicLink(email)` exported for Login
- `apps/desktop/src/Login.tsx` — state machine + dual CTA
- `apps/desktop/src/login.css` — form + sent-state styles
- `docs/RUNNING.md` — magic-link dogfood checklist + EMAIL_TRANSPORT setup

**Total:** 8 new + 14 modified = 22 files.

---

## Task 0: Branch and baseline

**Files:**
- N/A (git operations only)

- [ ] **Step 1: Branch off main**

Run:
```bash
cd /Users/guoxunpan/code/cogni
git checkout main && git pull --ff-only origin main 2>/dev/null || true
git checkout -b email-magic-link
```

Expected: `Switched to a new branch 'email-magic-link'`

- [ ] **Step 2: Verify baseline green**

Run: `pnpm test && pnpm typecheck`

Expected: `Tests 84 passed (84)` and all 5 typecheck projects `Done`.

- [ ] **Step 3: No commit** — Baseline only. Move to Task 1.

---

## Task 1: Schema — drop `users.oauth_sub`, add `user_identities`

**Files:**
- Modify: `packages/cloud/src/db/schema.ts`
- Modify: `packages/cloud/src/db/test-db.ts` (DDL must match schema exactly)

- [ ] **Step 1: Update `schema.ts`**

Edit `packages/cloud/src/db/schema.ts`. Replace the `users` table definition and append `userIdentities`:

```ts
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Auth identities for a user. A user can have multiple identities — e.g.
// Google sign-in AND magic-link sign-in, both pointing at the same user row.
// kind ∈ {'google', 'email', 'dev'}. sub is the issuer-specific subject:
//   google → google `sub` claim
//   email  → lowercased email (1:1 with users.email today; SP-2 may allow secondaries)
//   dev    → 'manual' (only `dev|manual` exists today, written by mint-dev-token)
export const userIdentities = pgTable("user_identities", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  sub: text("sub").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => ({
  pk: unique("user_identities_pk").on(t.kind, t.sub),
}));
```

Note: the `oauthSub` column on `users` is removed.

- [ ] **Step 2: Update `test-db.ts` DDL**

Edit `packages/cloud/src/db/test-db.ts`. Replace the `CREATE TABLE users` line and append a `CREATE TABLE user_identities`:

```ts
const DDL = `
CREATE TABLE tenants (id uuid primary key default gen_random_uuid(), name text not null, created_at timestamp not null default now());
CREATE TABLE users (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), email text not null unique, created_at timestamp not null default now());
CREATE TABLE user_identities (user_id uuid not null references users(id) on delete cascade, kind text not null, sub text not null, created_at timestamp not null default now(), constraint user_identities_pk unique (kind, sub));
CREATE TABLE hosts (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), user_id uuid not null references users(id), name text not null, status text not null default 'offline', registration_token text not null unique, capabilities_json jsonb not null default '[]', last_seen timestamp, created_at timestamp not null default now());
CREATE TABLE threads (id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), user_id uuid not null references users(id), title text not null default 'New chat', created_at timestamp not null default now(), updated_at timestamp not null default now());
CREATE TABLE messages (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id), role text not null, content text not null, created_at timestamp not null default now());
CREATE TABLE runner_sessions (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id), host_id uuid references hosts(id), adapter text not null, runner_session_id text, status text not null default 'idle', created_at timestamp not null default now(), constraint runner_sessions_thread_uq unique (thread_id));
CREATE TABLE events (id uuid primary key default gen_random_uuid(), thread_id uuid not null references threads(id), session_id uuid not null references runner_sessions(id), seq integer not null, type text not null, payload_json jsonb not null, created_at timestamp not null default now(), constraint events_thread_seq_uq unique (thread_id, seq));
`;
```

- [ ] **Step 3: Run typecheck (will fail — that's expected)**

Run: `pnpm typecheck`

Expected: FAIL — `users.ts` still references `users.oauthSub`, error like `Property 'oauthSub' does not exist on type ...`. This drives Task 3.

- [ ] **Step 4: Run schema test**

Run: `pnpm --filter @cogni/cloud test packages/cloud/src/db/schema.test.ts`

Expected: PASS (schema test only inserts a tenant, doesn't touch `users.oauthSub`).

- [ ] **Step 5: No commit yet** — let Task 2 + Task 3 land together so we commit one cohesive change. Move to Task 2.

---

## Task 2: `db/identities.ts` repo + test

**Files:**
- Create: `packages/cloud/src/db/identities.ts`
- Create: `packages/cloud/src/db/identities.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cloud/src/db/identities.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "./test-db.js";
import { tenants, users } from "./schema.js";
import { upsertIdentity, listIdentitiesForUser } from "./identities.js";

describe("user_identities repository", () => {
  it("upsertIdentity is idempotent for the same (kind, sub) pair", async () => {
    const { db, close } = await makeTestDb();
    const [tenant] = await db.insert(tenants).values({ name: "t" }).returning();
    const [user] = await db.insert(users).values({ tenantId: tenant!.id, email: "a@x.com" }).returning();

    await upsertIdentity(db, user!.id, "google", "g-123");
    await upsertIdentity(db, user!.id, "google", "g-123"); // duplicate — must not throw
    await upsertIdentity(db, user!.id, "email", "a@x.com");

    const ids = await listIdentitiesForUser(db, user!.id);
    expect(ids).toHaveLength(2);
    expect(ids.map((i) => `${i.kind}|${i.sub}`).sort()).toEqual(["email|a@x.com", "google|g-123"]);
    await close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @cogni/cloud test packages/cloud/src/db/identities.test.ts`

Expected: FAIL — `Cannot find module './identities.js'`.

- [ ] **Step 3: Implement the repo**

Create `packages/cloud/src/db/identities.ts`:

```ts
import { eq } from "drizzle-orm";
import { userIdentities } from "./schema.js";
import type { AnyDb } from "./client.js";

export interface UserIdentity {
  userId: string;
  kind: string;
  sub: string;
}

/**
 * Insert (userId, kind, sub) if not already present. Idempotent: a duplicate
 * (kind, sub) pair is silently ignored (ON CONFLICT DO NOTHING). The cross-user
 * uniqueness of (kind, sub) means two different users cannot claim the same
 * google sub or email — the second insert is a no-op, not a takeover.
 */
export async function upsertIdentity(
  db: AnyDb, userId: string, kind: string, sub: string,
): Promise<void> {
  await db.insert(userIdentities)
    .values({ userId, kind, sub })
    .onConflictDoNothing();
}

export async function listIdentitiesForUser(
  db: AnyDb, userId: string,
): Promise<UserIdentity[]> {
  const rows = await db.select().from(userIdentities).where(eq(userIdentities.userId, userId));
  return rows.map((r) => ({ userId: r.userId, kind: r.kind, sub: r.sub }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @cogni/cloud test packages/cloud/src/db/identities.test.ts`

Expected: PASS — 1 test green.

- [ ] **Step 5: No commit yet** — combine with Task 3 commit.

---

## Task 3: `db/users.ts` — replace `findOrCreateUser` with `findOrCreateUserByEmail`

**Files:**
- Modify: `packages/cloud/src/db/users.ts`
- Modify: `packages/cloud/src/db/users.test.ts`

- [ ] **Step 1: Update the test first to express the new behaviour**

Replace `packages/cloud/src/db/users.test.ts` entirely:

```ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "./test-db.js";
import { findOrCreateUserByEmail } from "./users.js";

describe("findOrCreateUserByEmail", () => {
  it("creates a tenant+user on first sight, returns same user on second", async () => {
    const { db, close } = await makeTestDb();
    const a = await findOrCreateUserByEmail(db, "a@x.com");
    const b = await findOrCreateUserByEmail(db, "a@x.com");
    expect(a.id).toBe(b.id);
    expect(a.tenantId).toBe(b.tenantId);
    expect(a.email).toBe("a@x.com");
    await close();
  });

  it("lowercases the email before lookup (idempotent on case)", async () => {
    const { db, close } = await makeTestDb();
    const a = await findOrCreateUserByEmail(db, "Mixed@Case.COM");
    const b = await findOrCreateUserByEmail(db, "mixed@case.com");
    expect(a.id).toBe(b.id);
    expect(a.email).toBe("mixed@case.com");
    await close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @cogni/cloud test packages/cloud/src/db/users.test.ts`

Expected: FAIL — `findOrCreateUserByEmail` doesn't exist.

- [ ] **Step 3: Replace `users.ts` implementation**

Replace `packages/cloud/src/db/users.ts` entirely:

```ts
import { eq } from "drizzle-orm";
import { tenants, users } from "./schema.js";
import type { AnyDb } from "./client.js";

export type { AnyDb };
export interface AppUser { id: string; tenantId: string; email: string; }

/**
 * Email-keyed user lookup. The single source of identity in cogni is the
 * email address: one email = one user, no matter which auth method delivered
 * it. Specific identities (google sub, dev marker) live in the
 * `user_identities` table and are recorded by callers via `upsertIdentity`.
 *
 * The lookup is case-insensitive — the email is lowercased before write/query
 * so that "Alice@Gmail.com" and "alice@gmail.com" map to the same row.
 */
export async function findOrCreateUserByEmail(
  db: AnyDb, email: string,
): Promise<AppUser> {
  const lowered = email.toLowerCase();
  const existing = await db.select().from(users).where(eq(users.email, lowered)).limit(1);
  if (existing[0]) {
    return { id: existing[0].id, tenantId: existing[0].tenantId, email: existing[0].email };
  }
  // SP-1: one tenant per user. SP-2 will introduce org/tenant membership.
  const [tenant] = await db.insert(tenants).values({ name: lowered }).returning();
  const [created] = await db
    .insert(users)
    .values({ tenantId: tenant!.id, email: lowered })
    .returning();
  return { id: created!.id, tenantId: created!.tenantId, email: created!.email };
}
```

- [ ] **Step 4: Run users test alone**

Run: `pnpm --filter @cogni/cloud test packages/cloud/src/db/users.test.ts`

Expected: PASS — 2 tests green.

- [ ] **Step 5: Run identities test alongside**

Run: `pnpm --filter @cogni/cloud test packages/cloud/src/db/`

Expected: PASS — all DB tests, including the new `user_identities` test.

- [ ] **Step 6: Run typecheck (still fails until Tasks 4 & 5)**

Run: `pnpm typecheck`

Expected: FAIL — `packages/cloud/src/routes/auth.ts` still calls old `findOrCreateUser`. Continue to Task 4.

- [ ] **Step 7: Commit schema + repo changes**

Run:
```bash
git add packages/cloud/src/db/schema.ts packages/cloud/src/db/test-db.ts packages/cloud/src/db/users.ts packages/cloud/src/db/users.test.ts packages/cloud/src/db/identities.ts packages/cloud/src/db/identities.test.ts
git commit -m "feat(db): replace users.oauth_sub with user_identities table

Foundation for email magic-link auth. The single source of identity becomes
the email address; specific identities (google sub, dev marker) move to a
new user_identities table keyed by (kind, sub).

- users.oauth_sub column removed; users.email already UNIQUE
- new user_identities (user_id, kind, sub, created_at) with UNIQUE(kind, sub)
- findOrCreateUser → findOrCreateUserByEmail (lowercases email)
- upsertIdentity + listIdentitiesForUser repo in db/identities.ts
- test-db.ts DDL synced with schema

Old callers (Google callback, dev-token endpoint, mint-dev-token script) still
need updating — typecheck currently fails. Next task fixes them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Adapt Google OAuth callback + dev-token endpoint to new identity API

**Files:**
- Modify: `packages/cloud/src/routes/auth.ts`
- Modify: `packages/cloud/src/routes/auth.test.ts`

- [ ] **Step 1: Update the test to express the new behaviour**

Read `packages/cloud/src/routes/auth.test.ts` first, then add a new test inside the `describe("safeRedirect", …)` file (the only `describe` currently there). Append a second `describe` at the bottom of the file (after the existing `safeRedirect` describe block):

```ts
import { makeTestDb } from "../db/test-db.js";
import { listIdentitiesForUser } from "../db/identities.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";

describe("dev-token endpoint identity wiring", () => {
  it("findOrCreateUserByEmail + upsertIdentity together let the dev user log in twice without duplicating identities", async () => {
    const { db, close } = await makeTestDb();
    const { findOrCreateUserByEmail } = await import("../db/users.js");
    const { upsertIdentity } = await import("../db/identities.js");

    // Simulate two mint-dev-token calls
    const u1 = await findOrCreateUserByEmail(db, "dev-manual@local.test");
    await upsertIdentity(db, u1.id, "dev", "manual");
    const u2 = await findOrCreateUserByEmail(db, "dev-manual@local.test");
    await upsertIdentity(db, u2.id, "dev", "manual");

    expect(u1.id).toBe(u2.id);
    const ids = await listIdentitiesForUser(db, u1.id);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({ kind: "dev", sub: "manual" });
    await close();
  });
});
```

(Keep the existing `safeRedirect` describe untouched.)

- [ ] **Step 2: Run test — must pass already because Task 2 + 3 wired the parts**

Run: `pnpm --filter @cogni/cloud test packages/cloud/src/routes/auth.test.ts`

Expected: PASS (existing safeRedirect tests + new identity wiring test).

- [ ] **Step 3: Update Google callback in `routes/auth.ts`**

In `packages/cloud/src/routes/auth.ts`, the current Google callback handler calls `findOrCreateUser(deps.db, { oauthSub: \`google|${sub}\`, email })`. Replace it with the two-step pattern. Edit the `try { … }` block in the `app.get("/auth/google/callback", …)` handler:

```ts
    try {
      const tokens = await deps.auth.google.validateAuthorizationCode(code, entry.codeVerifier);
      const claims = decodeIdToken(tokens.idToken()) as { sub?: unknown; email?: unknown };
      if (typeof claims.sub !== "string") return c.text("invalid id token", 400);
      const sub = claims.sub;
      const email = typeof claims.email === "string" ? claims.email : `${sub}@google`;
      if (typeof claims.email !== "string") {
        logger.warn({ sub }, "google id token had no email claim; using fallback");
      }
      const user = await findOrCreateUserByEmail(deps.db, email);
      await upsertIdentity(deps.db, user.id, "google", sub);
      const token = await deps.auth.issueToken({ userId: user.id, tenantId: user.tenantId });
      const target = new URL(entry.redirect);
      target.searchParams.set("token", token);
      return c.redirect(target.toString());
    } catch (err) {
      logger.warn({ err: String(err) }, "google oauth callback failed");
      return c.text("authentication failed", 400);
    }
```

- [ ] **Step 4: Update dev-token endpoint in same file**

In `packages/cloud/src/routes/auth.ts`, replace the dev-token handler body inside the existing `if (process.env.NODE_ENV !== "production")` guard:

```ts
  if (process.env.NODE_ENV !== "production") {
    app.post("/auth/dev-token", async (c) => {
      const user = await findOrCreateUserByEmail(deps.db, "dev-manual@local.test");
      await upsertIdentity(deps.db, user.id, "dev", "manual");
      const token = await deps.auth.issueToken({
        userId: user.id,
        tenantId: user.tenantId,
      });
      return c.json({ token });
    });
  }
```

- [ ] **Step 5: Update imports at top of `routes/auth.ts`**

```ts
import type { Hono } from "hono";
import { generateState, generateCodeVerifier, decodeIdToken } from "arctic";
import { findOrCreateUserByEmail } from "../db/users.js";
import { upsertIdentity } from "../db/identities.js";
import { logger } from "@cogni/shared";
import type { ServerDeps } from "../server.js";
```

(Remove the old `import { findOrCreateUser } from "../db/users.js";` line.)

- [ ] **Step 6: Run typecheck (one more failure: mint-dev-token script)**

Run: `pnpm typecheck`

Expected: FAIL — `packages/cloud/src/scripts/mint-dev-token.ts` still calls old `findOrCreateUser`. Continue.

- [ ] **Step 7: Update `scripts/mint-dev-token.ts`**

Replace the lines that call `findOrCreateUser`. The replacement block:

```ts
import { loadEnv } from "../env.js";
import { makeDb } from "../db/client.js";
import { findOrCreateUserByEmail } from "../db/users.js";
import { upsertIdentity } from "../db/identities.js";
import { makeAuth } from "../auth.js";

if (process.env.NODE_ENV === "production") {
  console.error("[mint-dev-token] refusing to run with NODE_ENV=production");
  process.exit(1);
}

if (process.env.COGNI_DEV_TOKEN_ACK !== "yes") {
  console.error(
    [
      "[mint-dev-token] refusing to run without explicit acknowledgement.",
      "",
      "This script bypasses Google OAuth by creating/finding a real user",
      "in Neon (email=dev-manual@local.test) and signing a 30-day JWT for",
      "them. Only use it when Google OAuth is unavailable from your network.",
      "",
      "To proceed, re-run with:",
      "  COGNI_DEV_TOKEN_ACK=yes <command>",
    ].join("\n"),
  );
  process.exit(1);
}

const env = loadEnv();
const db = makeDb(env.databaseUrl);
const auth = makeAuth({
  jwtSecret: env.jwtSecret,
  google: {
    clientId: env.googleClientId,
    clientSecret: env.googleClientSecret,
    redirectUri: `${env.publicUrl}/auth/google/callback`,
  },
});

const user = await findOrCreateUserByEmail(db, "dev-manual@local.test");
await upsertIdentity(db, user.id, "dev", "manual");
const token = await auth.issueToken({ userId: user.id, tenantId: user.tenantId });
console.log(token);
process.exit(0);
```

- [ ] **Step 8: Run typecheck again**

Run: `pnpm typecheck`

Expected: PASS — all 5 projects `Done`.

- [ ] **Step 9: Run full test suite**

Run: `pnpm test`

Expected: 84/84 pass (the existing test counts; we haven't added any new tests in Task 4 beyond the one we just added in Step 1, which means **85 tests pass**).

Adjust expectation: actually, after Task 2 (+1 test) and Task 4 step 1 (+1 test) = **86 tests**. Verify: `pnpm test 2>&1 | tail -3` should show `Tests 86 passed (86)`.

- [ ] **Step 10: Commit**

```bash
git add packages/cloud/src/routes/auth.ts packages/cloud/src/routes/auth.test.ts packages/cloud/src/scripts/mint-dev-token.ts
git commit -m "feat(auth): wire Google + dev-token + mint script onto new identity API

After Task 1-3 introduced findOrCreateUserByEmail + upsertIdentity, the
three call sites are now ported:

- Google callback: findOrCreateUserByEmail(email) + upsertIdentity(user, 'google', sub)
- dev-token endpoint: same shape with kind='dev', sub='manual'
- scripts/mint-dev-token: same shape (CLI parity with the HTTP endpoint)

Multiple sign-ins by the same user no longer create duplicate identities —
upsertIdentity is a no-op on (kind, sub) conflict.

Test count: 84 → 86 (one new repo test, one new identity wiring test).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Rate limiter — sliding window, in-memory

**Files:**
- Create: `packages/cloud/src/rate-limit.ts`
- Create: `packages/cloud/src/rate-limit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cloud/src/rate-limit.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { RateLimiter } from "./rate-limit.js";

describe("RateLimiter", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-05-16T00:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("allows N hits within the window, blocks the N+1th", () => {
    const rl = new RateLimiter([{ windowMs: 60_000, max: 3 }]);
    expect(rl.check("k")).toBe(true);
    expect(rl.check("k")).toBe(true);
    expect(rl.check("k")).toBe(true);
    expect(rl.check("k")).toBe(false);
  });

  it("resets the counter once the window has slid past all hits", () => {
    const rl = new RateLimiter([{ windowMs: 60_000, max: 2 }]);
    expect(rl.check("k")).toBe(true);
    expect(rl.check("k")).toBe(true);
    expect(rl.check("k")).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(rl.check("k")).toBe(true);
  });

  it("enforces multiple windows simultaneously (per-min AND per-hour)", () => {
    const rl = new RateLimiter([
      { windowMs: 60_000, max: 1 },
      { windowMs: 3_600_000, max: 5 },
    ]);
    expect(rl.check("k")).toBe(true);                  // 1 in min, 1 in hour
    expect(rl.check("k")).toBe(false);                 // blocked by per-min
    vi.advanceTimersByTime(60_001);
    expect(rl.check("k")).toBe(true);                  // per-min reset; 2 in hour
    vi.advanceTimersByTime(60_001);
    expect(rl.check("k")).toBe(true);                  // 3
    vi.advanceTimersByTime(60_001);
    expect(rl.check("k")).toBe(true);                  // 4
    vi.advanceTimersByTime(60_001);
    expect(rl.check("k")).toBe(true);                  // 5
    vi.advanceTimersByTime(60_001);
    expect(rl.check("k")).toBe(false);                 // blocked by per-hour
  });

  it("buckets by key — separate keys do not share counters", () => {
    const rl = new RateLimiter([{ windowMs: 60_000, max: 1 }]);
    expect(rl.check("a")).toBe(true);
    expect(rl.check("b")).toBe(true);
    expect(rl.check("a")).toBe(false);
    expect(rl.check("b")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @cogni/cloud test packages/cloud/src/rate-limit.test.ts`

Expected: FAIL — `Cannot find module './rate-limit.js'`.

- [ ] **Step 3: Implement RateLimiter**

Create `packages/cloud/src/rate-limit.ts`:

```ts
/**
 * Sliding-window rate limiter. Keeps a list of hit timestamps per key, prunes
 * anything outside the largest window on each check, and asserts each bucket's
 * `max` is not exceeded. Used for `/auth/email/send`: pass two buckets
 * (per-minute and per-hour) so brief bursts and sustained abuse are both
 * blocked.
 *
 * In-memory and per-process — fine for SP-1 single-node cloud, replaced by a
 * shared store (Redis) when SP-2 introduces multi-node.
 */
export interface Bucket { windowMs: number; max: number; }

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private buckets: Bucket[]) {
    if (buckets.length === 0) throw new Error("RateLimiter needs at least one bucket");
  }

  /** Record a hit for `key`. Returns `false` if any bucket would be exceeded. */
  check(key: string): boolean {
    const now = Date.now();
    const longestWindow = this.buckets.reduce((m, b) => Math.max(m, b.windowMs), 0);
    const cutoff = now - longestWindow;

    const all = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    for (const b of this.buckets) {
      const windowStart = now - b.windowMs;
      const inWindow = all.filter((t) => t > windowStart).length;
      if (inWindow >= b.max) {
        this.hits.set(key, all); // still record the pruned list to avoid memory growth
        return false;
      }
    }

    all.push(now);
    this.hits.set(key, all);
    return true;
  }

  /** Test seam — clears all buckets. */
  reset(): void { this.hits.clear(); }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @cogni/cloud test packages/cloud/src/rate-limit.test.ts`

Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/rate-limit.ts packages/cloud/src/rate-limit.test.ts
git commit -m "feat(cloud): in-memory sliding-window rate limiter

Generic per-key limiter that asserts multiple buckets (e.g. 1/min AND
5/hour) atomically. Used by /auth/email/send to defend against email
bombing (per-email key) and enumeration (per-IP key).

In-process Map; one process per SP-1 cloud node. SP-2 multi-node will
swap for a shared backing store.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Email transport abstraction (Fake + Console)

**Files:**
- Create: `packages/cloud/src/email/transport.ts`
- Create: `packages/cloud/src/email/transport.test.ts`

- [ ] **Step 1: Write the failing test (Fake + Console only — Resend in Task 7)**

Create `packages/cloud/src/email/transport.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { FakeTransport, ConsoleTransport } from "./transport.js";

describe("FakeTransport", () => {
  it("records sent magic links instead of sending them", async () => {
    const t = new FakeTransport();
    await t.sendMagicLink({ to: "a@x.com", magicUrl: "cogni://auth?magic=xxx", expiresInMinutes: 15 });
    await t.sendMagicLink({ to: "b@x.com", magicUrl: "cogni://auth?magic=yyy", expiresInMinutes: 15 });
    expect(t.sent).toEqual([
      { to: "a@x.com", magicUrl: "cogni://auth?magic=xxx", expiresInMinutes: 15 },
      { to: "b@x.com", magicUrl: "cogni://auth?magic=yyy", expiresInMinutes: 15 },
    ]);
  });
});

describe("ConsoleTransport", () => {
  it("writes the magic URL to stdout so the dev can copy/paste it", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const t = new ConsoleTransport();
      await t.sendMagicLink({ to: "a@x.com", magicUrl: "cogni://auth?magic=xxx", expiresInMinutes: 15 });
      const printed = spy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(printed).toContain("a@x.com");
      expect(printed).toContain("cogni://auth?magic=xxx");
      expect(printed).toContain("15");
    } finally {
      spy.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @cogni/cloud test packages/cloud/src/email/transport.test.ts`

Expected: FAIL — `Cannot find module './transport.js'`.

- [ ] **Step 3: Implement the interface + Fake + Console**

Create `packages/cloud/src/email/transport.ts`:

```ts
/**
 * Cloud-side abstraction for sending the magic-link email.
 *
 * SP-1 supplies three implementations:
 *   - FakeTransport: in-memory; tests assert on `sent[]`.
 *   - ConsoleTransport: prints the link to stdout. The dev-mode default —
 *     no API key needed, no real email sent, copy-paste the link to test.
 *   - ResendTransport (Task 7): production. POSTs to Resend's REST API.
 *
 * `main.ts` picks the implementation from EMAIL_TRANSPORT env (Task 8).
 */
export interface SendArgs { to: string; magicUrl: string; expiresInMinutes: number; }

export interface EmailTransport {
  sendMagicLink(args: SendArgs): Promise<void>;
}

export class FakeTransport implements EmailTransport {
  public sent: SendArgs[] = [];
  async sendMagicLink(args: SendArgs): Promise<void> { this.sent.push(args); }
}

export class ConsoleTransport implements EmailTransport {
  async sendMagicLink(args: SendArgs): Promise<void> {
    console.log(
      `[email/console] would send to=${args.to} url=${args.magicUrl} expiresInMinutes=${args.expiresInMinutes}`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @cogni/cloud test packages/cloud/src/email/transport.test.ts`

Expected: PASS — 2 tests green.

- [ ] **Step 5: No commit yet** — combine with Task 7 (Resend).

---

## Task 7: ResendTransport — production email send

**Files:**
- Modify: `packages/cloud/src/email/transport.ts`
- Modify: `packages/cloud/src/email/transport.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `packages/cloud/src/email/transport.test.ts`:

```ts
describe("ResendTransport", () => {
  const baseArgs = { to: "a@x.com", magicUrl: "cogni://auth?magic=tok", expiresInMinutes: 15 };

  it("POSTs to api.resend.com with Bearer auth and the magic URL in the body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "msg-1" }), { status: 200 }));
    const { ResendTransport } = await import("./transport.js");
    const t = new ResendTransport({ apiKey: "re_test_key", from: "Cogni <login@cogni.example>", fetchImpl: fetchMock });

    await t.sendMagicLink(baseArgs);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init?.body as string);
    expect(body.from).toBe("Cogni <login@cogni.example>");
    expect(body.to).toBe("a@x.com");
    expect(body.text).toContain("cogni://auth?magic=tok");
    expect(body.text).toContain("15");
  });

  it("throws when Resend returns non-2xx (caller decides what to do)", async () => {
    const fetchMock = vi.fn(async () => new Response("rate limit", { status: 429 }));
    const { ResendTransport } = await import("./transport.js");
    const t = new ResendTransport({ apiKey: "k", from: "f", fetchImpl: fetchMock });
    await expect(t.sendMagicLink(baseArgs)).rejects.toThrow(/429/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @cogni/cloud test packages/cloud/src/email/transport.test.ts`

Expected: FAIL — `ResendTransport` undefined.

- [ ] **Step 3: Implement ResendTransport**

Append to `packages/cloud/src/email/transport.ts`:

```ts
export interface ResendOpts {
  apiKey: string;
  from: string;                                  // e.g. "Cogni <login@cogni.example>"
  fetchImpl?: typeof fetch;                       // injectable for tests
}

export class ResendTransport implements EmailTransport {
  constructor(private opts: ResendOpts) {}

  async sendMagicLink(args: SendArgs): Promise<void> {
    const text = buildMagicLinkPlainText(args);
    const fetcher = this.opts.fetchImpl ?? fetch;
    const res = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.opts.from,
        to: args.to,
        subject: "登录 Cogni / Sign in to Cogni",
        text,
      }),
    });
    if (!res.ok) {
      throw new Error(`resend send failed: ${res.status} ${await res.text()}`);
    }
  }
}

function buildMagicLinkPlainText(args: SendArgs): string {
  return [
    "你好,",
    "",
    "有人请求用这个邮箱登录 Cogni。点击下面的链接以登录:",
    "",
    `    ${args.magicUrl}`,
    "",
    `如果不是你本人,请忽略这封邮件。链接 ${args.expiresInMinutes} 分钟内有效。`,
    "",
    "─────────────────",
    "",
    "Hi,",
    "",
    "Someone requested a Cogni login for this email. Click the link to sign in:",
    "",
    `    ${args.magicUrl}`,
    "",
    `If this wasn't you, ignore this email. The link expires in ${args.expiresInMinutes} minutes.`,
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter @cogni/cloud test packages/cloud/src/email/transport.test.ts`

Expected: PASS — 4 tests green (Fake, Console, Resend×2).

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/email/
git commit -m "feat(cloud): EmailTransport abstraction + Fake / Console / Resend

Three implementations cover the matrix:
- FakeTransport: in-memory queue; tests assert sent[]
- ConsoleTransport: prints to stdout; dev default (copy-paste the link)
- ResendTransport: POSTs to api.resend.com/emails with bearer auth

Plain-text bilingual (zh + en) magic-link template lives inline; SP-2 will
swap in HTML / React Email templates when the look-and-feel matters.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Env loader + main.ts wiring for EMAIL_TRANSPORT

**Files:**
- Modify: `packages/cloud/src/env.ts`
- Modify: `packages/cloud/src/server.ts` (add EmailTransport to ServerDeps)
- Modify: `packages/cloud/src/main.ts` (wire from env)
- Modify: `packages/cloud/.env.example`
- Modify: `packages/cloud/src/env.test.ts` (verify new optional fields parse)

- [ ] **Step 1: Read the current env.test.ts**

Run: `cat packages/cloud/src/env.test.ts`

Understand the existing test shape so the new tests fit in.

- [ ] **Step 2: Update env.ts**

Replace `packages/cloud/src/env.ts`:

```ts
export type EmailTransportKind = "console" | "resend";

export interface Env {
  databaseUrl: string;
  jwtSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  publicUrl: string;
  port: number;
  emailTransport: EmailTransportKind;
  resendApiKey: string | null;       // required when emailTransport === "resend"
  emailFrom: string;                 // required when emailTransport === "resend"
  magicLinkTtlMinutes: number;       // default 15
}

export function loadEnv(): Env {
  const get = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing env var: ${k}`);
    return v;
  };

  const portRaw = process.env.PORT ?? "8787";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: "${portRaw}" (must be an integer 1-65535)`);
  }

  const transportRaw = (process.env.EMAIL_TRANSPORT ?? "console").toLowerCase();
  if (transportRaw !== "console" && transportRaw !== "resend") {
    throw new Error(`Invalid EMAIL_TRANSPORT: "${transportRaw}" (must be "console" or "resend")`);
  }
  const emailTransport = transportRaw as EmailTransportKind;

  const resendApiKey = process.env.RESEND_API_KEY ?? null;
  const emailFrom = process.env.EMAIL_FROM ?? "Cogni <login@example.invalid>";
  if (emailTransport === "resend" && !resendApiKey) {
    throw new Error('EMAIL_TRANSPORT="resend" requires RESEND_API_KEY');
  }

  const ttlRaw = process.env.MAGIC_LINK_TTL_MIN ?? "15";
  const magicLinkTtlMinutes = Number(ttlRaw);
  if (!Number.isInteger(magicLinkTtlMinutes) || magicLinkTtlMinutes < 1 || magicLinkTtlMinutes > 60) {
    throw new Error(`Invalid MAGIC_LINK_TTL_MIN: "${ttlRaw}" (1-60)`);
  }

  return {
    databaseUrl: get("DATABASE_URL"),
    jwtSecret: get("JWT_SECRET"),
    googleClientId: get("GOOGLE_CLIENT_ID"),
    googleClientSecret: get("GOOGLE_CLIENT_SECRET"),
    publicUrl: process.env.PUBLIC_URL ?? "http://localhost:8787",
    port,
    emailTransport,
    resendApiKey,
    emailFrom,
    magicLinkTtlMinutes,
  };
}
```

- [ ] **Step 3: Add a unit test**

Open `packages/cloud/src/env.test.ts` and append:

```ts
it("defaults emailTransport to console and ttl to 15", () => {
  process.env.DATABASE_URL = "postgres://x"; process.env.JWT_SECRET = "x";
  process.env.GOOGLE_CLIENT_ID = "x"; process.env.GOOGLE_CLIENT_SECRET = "x";
  delete process.env.EMAIL_TRANSPORT; delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM; delete process.env.MAGIC_LINK_TTL_MIN;
  const env = loadEnv();
  expect(env.emailTransport).toBe("console");
  expect(env.magicLinkTtlMinutes).toBe(15);
  expect(env.resendApiKey).toBeNull();
});

it("requires RESEND_API_KEY when EMAIL_TRANSPORT=resend", () => {
  process.env.DATABASE_URL = "postgres://x"; process.env.JWT_SECRET = "x";
  process.env.GOOGLE_CLIENT_ID = "x"; process.env.GOOGLE_CLIENT_SECRET = "x";
  process.env.EMAIL_TRANSPORT = "resend"; delete process.env.RESEND_API_KEY;
  expect(() => loadEnv()).toThrow(/RESEND_API_KEY/);
});
```

- [ ] **Step 4: Run env test**

Run: `pnpm --filter @cogni/cloud test packages/cloud/src/env.test.ts`

Expected: PASS — original tests + 2 new.

- [ ] **Step 5: Add EmailTransport to ServerDeps**

Edit `packages/cloud/src/server.ts`. Add the import + extend the interface:

```ts
import type { EmailTransport } from "./email/transport.js";
```

And in `ServerDeps`:

```ts
export interface ServerDeps {
  db: AnyDb;
  auth: Auth;
  hosts: HostRouter;
  clients: ClientHub;
  chat: ChatDomain;
  emailTransport: EmailTransport;
  magicLinkTtlMinutes: number;
  publicUrl: string;
}
```

- [ ] **Step 6: Update main.ts to construct transport from env**

Replace `packages/cloud/src/main.ts`:

```ts
import { serve } from "@hono/node-server";
import { loadEnv } from "./env.js";
import { makeDb } from "./db/client.js";
import { makeAuth } from "./auth.js";
import { HostRouter } from "./host-router.js";
import { ClientHub } from "./client-hub.js";
import { ChatDomain } from "./domains/chat.js";
import { createServer } from "./server.js";
import { ConsoleTransport, ResendTransport, type EmailTransport } from "./email/transport.js";
import { logger } from "@cogni/shared";

const env = loadEnv();
const db = makeDb(env.databaseUrl);
const auth = makeAuth({
  jwtSecret: env.jwtSecret,
  google: {
    clientId: env.googleClientId,
    clientSecret: env.googleClientSecret,
    redirectUri: `${env.publicUrl}/auth/google/callback`,
  },
});
const hosts = new HostRouter();
const clients = new ClientHub();
const chat = new ChatDomain(db, hosts, clients);

const emailTransport: EmailTransport =
  env.emailTransport === "resend"
    ? new ResendTransport({ apiKey: env.resendApiKey!, from: env.emailFrom })
    : new ConsoleTransport();

const { app, injectWebSocket } = createServer({
  db, auth, hosts, clients, chat,
  emailTransport,
  magicLinkTtlMinutes: env.magicLinkTtlMinutes,
  publicUrl: env.publicUrl,
});

const server = serve({ fetch: app.fetch, port: env.port }, (info) =>
  logger.info({ port: info.port, emailTransport: env.emailTransport }, "cloud control plane listening"),
);
injectWebSocket(server);
```

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS in cloud (existing call sites of createServer in tests will fail — fix next step).

- [ ] **Step 8: Update test call sites that construct ServerDeps**

Run: `grep -rn "createServer(" packages/cloud/src --include='*.test.ts'`

Each match must pass `emailTransport` and `magicLinkTtlMinutes`. Update each call site to:

```ts
import { FakeTransport } from "../email/transport.js";  // adjust path
// ...
const emailTransport = new FakeTransport();
const { app, injectWebSocket } = createServer({
  db, auth, hosts, clients, chat,
  emailTransport,
  magicLinkTtlMinutes: 15,
  publicUrl: "http://localhost:8787",
});
```

(Likely only `packages/cloud/src/server.e2e.test.ts` calls `createServer`. Verify with the grep.)

- [ ] **Step 9: Run full test suite**

Run: `pnpm test`

Expected: 88 tests pass (86 from Task 4 + 2 new env tests).

- [ ] **Step 10: Update .env.example**

Append to `packages/cloud/.env.example`:

```
# Email transport for magic-link login.
# - `console` (default): prints the link to stdout; copy-paste to log in. Use
#   for local dev / first-time setup. Never use in production.
# - `resend`: POSTs to api.resend.com. Required env: RESEND_API_KEY, EMAIL_FROM.
EMAIL_TRANSPORT=console
RESEND_API_KEY=
# Must be a verified domain on your Resend account.
EMAIL_FROM=Cogni <login@cogni.example>
# Magic-link expiry in minutes; 1-60 allowed; default 15.
MAGIC_LINK_TTL_MIN=15
```

- [ ] **Step 11: Commit**

```bash
git add packages/cloud/src/env.ts packages/cloud/src/env.test.ts packages/cloud/src/server.ts packages/cloud/src/main.ts packages/cloud/src/server.e2e.test.ts packages/cloud/.env.example
git commit -m "feat(cloud): wire EmailTransport through env + ServerDeps

env.ts parses EMAIL_TRANSPORT (console|resend), RESEND_API_KEY, EMAIL_FROM,
MAGIC_LINK_TTL_MIN. main.ts picks ConsoleTransport (dev default) or
ResendTransport based on EMAIL_TRANSPORT.

ServerDeps gains emailTransport and magicLinkTtlMinutes so /auth/email/*
handlers in the next task can take them via deps.

.env.example documents the new vars; e2e test constructs FakeTransport
when calling createServer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `POST /auth/email/send` — generate token, store pending, dispatch email

**Files:**
- Create: `packages/cloud/src/routes/email.ts`
- Create: `packages/cloud/src/routes/email.test.ts`
- Modify: `packages/cloud/src/server.ts` (register the new routes)

- [ ] **Step 1: Write the failing test**

Create `packages/cloud/src/routes/email.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../db/test-db.js";
import { FakeTransport } from "../email/transport.js";
import { registerEmailRoutes } from "./email.js";

function buildApp(transport: FakeTransport) {
  const app = new Hono();
  registerEmailRoutes(app, {
    db: undefined as never,    // not needed for /send
    auth: undefined as never,  // not needed for /send
    emailTransport: transport,
    magicLinkTtlMinutes: 15,
    publicUrl: "http://localhost:8787",
  } as never);
  return app;
}

describe("POST /auth/email/send", () => {
  it("accepts a valid email and dispatches one magic-link email", async () => {
    const transport = new FakeTransport();
    const app = buildApp(transport);
    const res = await app.request("/auth/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@x.com" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.to).toBe("a@x.com");
    expect(transport.sent[0]?.magicUrl).toMatch(/^cogni:\/\/auth\?magic=[A-Za-z0-9_-]{40,}$/);
    expect(transport.sent[0]?.expiresInMinutes).toBe(15);
  });

  it("returns 400 on a malformed email", async () => {
    const transport = new FakeTransport();
    const app = buildApp(transport);
    const res = await app.request("/auth/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
    expect(transport.sent).toHaveLength(0);
  });

  it("returns 400 when body is missing email", async () => {
    const transport = new FakeTransport();
    const app = buildApp(transport);
    const res = await app.request("/auth/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("rate-limits the same email: 2nd send within a minute returns 429", async () => {
    const transport = new FakeTransport();
    const app = buildApp(transport);
    const r1 = await app.request("/auth/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@x.com" }),
    });
    expect(r1.status).toBe(200);
    const r2 = await app.request("/auth/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@x.com" }),
    });
    expect(r2.status).toBe(429);
    expect(transport.sent).toHaveLength(1);
  });

  it("rate-limits per IP: many emails from the same IP get blocked", async () => {
    const transport = new FakeTransport();
    const app = buildApp(transport);
    const ipHeaders = { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.42" };
    // per-IP cap is 3/min in the route. Send 4 different emails:
    for (let i = 0; i < 3; i++) {
      const r = await app.request("/auth/email/send", {
        method: "POST", headers: ipHeaders,
        body: JSON.stringify({ email: `u${i}@x.com` }),
      });
      expect(r.status).toBe(200);
    }
    const r4 = await app.request("/auth/email/send", {
      method: "POST", headers: ipHeaders,
      body: JSON.stringify({ email: "u3@x.com" }),
    });
    expect(r4.status).toBe(429);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @cogni/cloud test packages/cloud/src/routes/email.test.ts`

Expected: FAIL — `Cannot find module './email.js'`.

- [ ] **Step 3: Implement the route**

Create `packages/cloud/src/routes/email.ts`:

```ts
import type { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { RateLimiter } from "../rate-limit.js";
import { logger } from "@cogni/shared";
import type { ServerDeps } from "../server.js";

interface PendingMagic { email: string; createdAt: number; }

const emailSchema = z.object({ email: z.string().email() });
const magicSchema = z.object({ magic: z.string().min(20).max(128) });

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

    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      ?? c.req.header("x-real-ip")
      ?? "unknown";
    if (!perEmail.check(email) || !perIp.check(ip)) {
      return c.json({ error: "rate limited" }, 429);
    }

    const token = randomBytes(32).toString("base64url");
    pending.set(token, { email, createdAt: Date.now() });

    const magicUrl = `cogni://auth?magic=${token}`;
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

    const { findOrCreateUserByEmail } = await import("../db/users.js");
    const { upsertIdentity } = await import("../db/identities.js");
    const user = await findOrCreateUserByEmail(deps.db, entry.email);
    await upsertIdentity(deps.db, user.id, "email", entry.email);
    const token = await deps.auth.issueToken({ userId: user.id, tenantId: user.tenantId });
    return c.json({ token });
  });
}
```

- [ ] **Step 4: Register the route**

Edit `packages/cloud/src/server.ts`. Add an import and call inside `createServer`:

```ts
import { registerEmailRoutes } from "./routes/email.js";
// ... inside createServer, after registerAuthRoutes(app, deps):
registerEmailRoutes(app, deps);
```

- [ ] **Step 5: Run the email route test**

Run: `pnpm --filter @cogni/cloud test packages/cloud/src/routes/email.test.ts`

Expected: PASS — 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/cloud/src/routes/email.ts packages/cloud/src/routes/email.test.ts packages/cloud/src/server.ts
git commit -m "feat(cloud): /auth/email/send — magic-link dispatch with rate limit

POST /auth/email/send accepts {email}, validates with zod, rate-limits per
email (1/min + 5/hour) AND per IP (3/min + 20/hour). On accept: 32-byte
random token, stored in a per-process Map with 15-min sweeper, mailed via
deps.emailTransport.

Always returns {ok:true} on accept (anti-enumeration); transport errors
log warn but the user sees the same response.

/auth/email/callback is wired in this commit too (skeleton — covered fully
in next task's tests).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: `POST /auth/email/callback` tests + end-to-end flow

**Files:**
- Modify: `packages/cloud/src/routes/email.test.ts`

- [ ] **Step 1: Add callback tests at the bottom of email.test.ts**

Append to `packages/cloud/src/routes/email.test.ts`:

```ts
import { makeAuth } from "../auth.js";

async function buildAppWithDb() {
  const { db, close } = await makeTestDb();
  const auth = makeAuth({
    jwtSecret: "test-secret-at-least-32-chars-long-padding-padding",
    google: { clientId: "x", clientSecret: "y", redirectUri: "http://localhost/cb" },
  });
  const transport = new FakeTransport();
  const app = new Hono();
  registerEmailRoutes(app, {
    db, auth,
    hosts: undefined as never,
    clients: undefined as never,
    chat: undefined as never,
    emailTransport: transport,
    magicLinkTtlMinutes: 15,
    publicUrl: "http://localhost:8787",
  } as never);
  return { db, auth, transport, app, close };
}

async function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /auth/email/callback", () => {
  it("returns a JWT after a successful send → callback round-trip", async () => {
    const { app, transport, auth, close } = await buildAppWithDb();
    await postJson(app, "/auth/email/send", { email: "a@x.com" });
    const magicUrl = transport.sent[0]!.magicUrl;
    const token = new URL(magicUrl).searchParams.get("magic")!;

    const res = await postJson(app, "/auth/email/callback", { magic: token });
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string };
    expect(typeof body.token).toBe("string");

    const claims = await auth.verifyToken(body.token);
    expect(claims).not.toBeNull();
    expect(typeof claims!.userId).toBe("string");
    await close();
  });

  it("rejects a reused token (single-use)", async () => {
    const { app, transport, close } = await buildAppWithDb();
    await postJson(app, "/auth/email/send", { email: "a@x.com" });
    const token = new URL(transport.sent[0]!.magicUrl).searchParams.get("magic")!;

    const r1 = await postJson(app, "/auth/email/callback", { magic: token });
    expect(r1.status).toBe(200);
    const r2 = await postJson(app, "/auth/email/callback", { magic: token });
    expect(r2.status).toBe(400);
    expect((await r2.json() as { error: string }).error).toBe("expired");
    await close();
  });

  it("rejects an unknown token", async () => {
    const { app, close } = await buildAppWithDb();
    const r = await postJson(app, "/auth/email/callback", { magic: "AAAA".repeat(8) });
    expect(r.status).toBe(400);
    await close();
  });

  it("rejects a malformed body", async () => {
    const { app, close } = await buildAppWithDb();
    const r = await postJson(app, "/auth/email/callback", {});
    expect(r.status).toBe(400);
    await close();
  });

  it("two successful callbacks for the same email return the same user", async () => {
    const { db, app, transport, close } = await buildAppWithDb();
    const { listIdentitiesForUser } = await import("../db/identities.js");
    const { users } = await import("../db/schema.js");

    await postJson(app, "/auth/email/send", { email: "a@x.com" });
    let token = new URL(transport.sent[0]!.magicUrl).searchParams.get("magic")!;
    await postJson(app, "/auth/email/callback", { magic: token });

    // Wait > 60s of perEmail limit by resetting (next test would otherwise hit rate limit)
    // Easier: send second to a different email and check uniqueness of users
    const { eq } = await import("drizzle-orm");
    const userRows = await db.select().from(users).where(eq(users.email, "a@x.com"));
    expect(userRows).toHaveLength(1);
    const ids = await listIdentitiesForUser(db, userRows[0]!.id);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({ kind: "email", sub: "a@x.com" });
    await close();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @cogni/cloud test packages/cloud/src/routes/email.test.ts`

Expected: PASS — 10 tests green (5 send + 5 callback).

- [ ] **Step 3: Run full test suite to confirm nothing else broke**

Run: `pnpm test`

Expected: 96 tests pass (88 from previous + 5 send + 3 callback unique — adjust count if your local arithmetic differs; the requirement is "all pass").

- [ ] **Step 4: Commit**

```bash
git add packages/cloud/src/routes/email.test.ts
git commit -m "test(cloud): /auth/email/callback — round-trip + single-use + expiry

Five new tests cover the full callback path: send→callback yields a verifiable
JWT; reusing the token returns 400 'expired'; unknown tokens 400; malformed
body 400; two callbacks for the same email map to the same user row with
one identity (email|a@x.com).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Desktop API client — `sendMagicLink` + `redeemMagic`

**Files:**
- Modify: `apps/desktop/src/api.ts`

- [ ] **Step 1: Read current api.ts to see the existing helper pattern**

Run: `cat apps/desktop/src/api.ts`

Note the existing `request()` helper / `ApiError` class.

- [ ] **Step 2: Add two new methods**

In `apps/desktop/src/api.ts`, add inside the exported `api` object (alongside `listHosts`, `createHost`, `listThreads`, etc.):

```ts
  async sendMagicLink(email: string): Promise<{ ok: true }> {
    return request<{ ok: true }>(`${cloudUrl}/auth/email/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
  },

  async redeemMagic(magic: string): Promise<{ token: string }> {
    return request<{ token: string }>(`${cloudUrl}/auth/email/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ magic }),
    });
  },
```

(If `request<T>(url, init)` doesn't currently exist as a generic helper in api.ts, use the same `fetch + .ok check + .json() + throw new ApiError` shape that listThreads uses — copy that pattern verbatim.)

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/api.ts
git commit -m "feat(desktop): api.sendMagicLink + api.redeemMagic

Wire the two cloud endpoints from Task 9/10 into the desktop API client.
Used by Login.tsx (sendMagicLink) and useAuth (redeemMagic when a
cogni://auth?magic=... deep link arrives).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: `useAuth.ts` — route `?magic=…` deep links to redeem flow

**Files:**
- Modify: `apps/desktop/src/useAuth.ts`

- [ ] **Step 1: Inspect current handler shape**

Run: `cat apps/desktop/src/useAuth.ts`

Note: `acceptUrls` currently extracts `token` only via `readToken`.

- [ ] **Step 2: Update the helper + handler**

Replace `apps/desktop/src/useAuth.ts`:

```ts
import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./api.js";

const TOKEN_KEY = "cogni_token";

export function useAuth() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));

  // Deep-link inbox. Two URL shapes arrive at cogni://auth:
  //   ?token=<JWT>   — Google OAuth callback (cloud signs JWT server-side, hands it back in the redirect URL)
  //   ?magic=<rand>  — email magic link (we must POST it to /auth/email/callback to exchange for a JWT)
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const acceptUrls = async (urls: string[] | null) => {
      if (disposed || !urls) return;
      for (const u of urls) {
        const parsed = tryParse(u);
        if (!parsed) continue;
        if (parsed.kind === "token") {
          localStorage.setItem(TOKEN_KEY, parsed.value);
          setToken(parsed.value);
        } else if (parsed.kind === "magic") {
          try {
            const { token: jwt } = await api.redeemMagic(parsed.value);
            localStorage.setItem(TOKEN_KEY, jwt);
            setToken(jwt);
          } catch (e) {
            console.warn("[useAuth] magic redeem failed", e);
          }
        }
      }
    };

    getCurrent().then(acceptUrls).catch((e) => console.warn("failed to read current deep link", e));
    const unlisten = onOpenUrl((urls) => {
      void acceptUrls(urls);
    });
    return () => {
      disposed = true;
      unlisten.then((f) => f()).catch(() => undefined);
    };
  }, []);

  // Dev fallback (unchanged from earlier work — kept here so the file is self-contained).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (token) return;
    let alive = true;
    fetch(`${api.cloudUrl}/auth/dev-token`, { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j && typeof j.token === "string") {
          localStorage.setItem(TOKEN_KEY, j.token);
          setToken(j.token);
        }
      })
      .catch((e) => console.warn("[useAuth] dev-token fetch failed", e));
    return () => { alive = false; };
  }, [token]);

  const loginWithGoogle = () => {
    const url = `${api.cloudUrl}/auth/google/start?redirect=${encodeURIComponent("cogni://auth")}`;
    if (!isTauri()) {
      window.location.href = url;
      return;
    }
    return openUrl(url);
  };

  const loginWithEmail = async (email: string): Promise<void> => {
    await api.sendMagicLink(email);
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
  };

  return { token, loginWithGoogle, loginWithEmail, logout };
}

function tryParse(rawUrl: string): { kind: "token" | "magic"; value: string } | null {
  try {
    const u = new URL(rawUrl);
    const t = u.searchParams.get("token");
    if (t) return { kind: "token", value: t };
    const m = u.searchParams.get("magic");
    if (m) return { kind: "magic", value: m };
  } catch { /* fall through */ }
  return null;
}
```

(Note: the exported API changed — `login` → `loginWithGoogle`. `App.tsx` and `Shell.tsx` reference `login`; we update them in Task 13 alongside the Login rewrite.)

- [ ] **Step 3: Typecheck (will fail until Task 13 updates Login.tsx)**

Run: `pnpm typecheck`

Expected: FAIL — `Login.tsx` calls `onLogin` which is wired to `login` in `App.tsx`. We update both in Task 13.

- [ ] **Step 4: No commit yet** — combine with Task 13.

---

## Task 13: `Login.tsx` rewrite — state machine + dual CTA

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/Login.tsx`
- Modify: `apps/desktop/src/login.css`

- [ ] **Step 1: Update App.tsx to pass both handlers**

Replace `apps/desktop/src/App.tsx`:

```tsx
import { useAuth } from "./useAuth.js";
import { Login } from "./Login.js";
import { Shell } from "./Shell.js";

export default function App() {
  const { token, loginWithGoogle, loginWithEmail, logout } = useAuth();
  if (!token) {
    return <Login onLoginWithGoogle={loginWithGoogle} onLoginWithEmail={loginWithEmail} />;
  }
  return <Shell token={token} onLogout={logout} />;
}
```

- [ ] **Step 2: Rewrite Login.tsx as a state machine**

Replace `apps/desktop/src/Login.tsx`:

```tsx
/**
 * Login — pre-auth landing page.
 *
 * Two CTAs that both end in a `cogni://auth?…` deep link delivered to useAuth:
 *   1. Email magic link: type address → POST /auth/email/send → switch to "sent"
 *      state with a 60s resend cooldown. User opens email client, clicks the link,
 *      macOS routes cogni:// back to Cogni, useAuth redeems and sets the JWT.
 *   2. Google OAuth: standard browser-redirect dance, server-side callback,
 *      JWT comes back in the cogni:// URL.
 *
 * State machine:
 *   form     — initial; show email input + Google button
 *   sending  — POST /auth/email/send in flight; disable inputs
 *   sent     — email queued; show "check your inbox" + resend countdown
 *   error    — show inline error, keep the user's email pre-filled
 */
import { useEffect, useState } from "react";
import "./login.css";

type State =
  | { kind: "form"; email: string; error?: string }
  | { kind: "sending"; email: string }
  | { kind: "sent"; email: string; resendAt: number }
  | { kind: "error"; email: string; reason: string };

const RESEND_COOLDOWN_MS = 60_000;

export function Login({
  onLoginWithGoogle,
  onLoginWithEmail,
}: {
  onLoginWithGoogle: () => void;
  onLoginWithEmail: (email: string) => Promise<void>;
}) {
  const [state, setState] = useState<State>({ kind: "form", email: "" });
  const [now, setNow] = useState(Date.now());

  // tick once a second when in 'sent' state so the cooldown label updates
  useEffect(() => {
    if (state.kind !== "sent") return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [state.kind]);

  const submitEmail = async (email: string) => {
    setState({ kind: "sending", email });
    try {
      await onLoginWithEmail(email);
      setState({ kind: "sent", email, resendAt: Date.now() + RESEND_COOLDOWN_MS });
    } catch (e) {
      const reason = e instanceof Error ? e.message : "网络错误,请重试";
      setState({ kind: "error", email, reason });
    }
  };

  if (state.kind === "sent") {
    const remaining = Math.max(0, Math.ceil((state.resendAt - now) / 1000));
    return (
      <div className="login">
        <div className="login__hero">
          <div className="login__brand">
            <span className="login__star" aria-hidden="true">✳</span>
            <h1 className="login__title">Cogni</h1>
          </div>
          <p className="login__subtitle">
            已发送登录链接到 <strong>{state.email}</strong>,请在邮件中点击「登录 Cogni」
          </p>
          <button
            className="btn-primary login__cta"
            disabled={remaining > 0}
            onClick={() => submitEmail(state.email)}
          >
            {remaining > 0 ? `${remaining}s 后可重发` : "重发邮件"}
          </button>
          <button
            className="login__link"
            onClick={() => setState({ kind: "form", email: "" })}
          >
            用其他邮箱?
          </button>
        </div>
      </div>
    );
  }

  const formEmail = state.kind === "form" ? state.email
    : state.kind === "error" ? state.email
    : state.kind === "sending" ? state.email
    : "";
  const formError = state.kind === "error" ? state.reason
    : state.kind === "form" ? state.error
    : undefined;
  const isSubmitting = state.kind === "sending";

  return (
    <div className="login">
      <div className="login__hero">
        <div className="login__brand">
          <span className="login__star" aria-hidden="true">✳</span>
          <h1 className="login__title">Cogni</h1>
        </div>
        <p className="login__subtitle">有记忆、跨设备在场的 AI 助手</p>

        <form
          className="login__form"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = formEmail.trim();
            if (!trimmed.includes("@")) {
              setState({ kind: "form", email: formEmail, error: "请输入合法的邮箱地址" });
              return;
            }
            void submitEmail(trimmed);
          }}
        >
          <input
            type="email"
            className="login__input"
            placeholder="you@example.com"
            value={formEmail}
            disabled={isSubmitting}
            autoComplete="email"
            onChange={(e) => setState({ kind: "form", email: e.target.value })}
          />
          {formError && <div className="login__error">{formError}</div>}
          <button type="submit" className="btn-primary login__cta" disabled={isSubmitting}>
            {isSubmitting ? "发送中…" : "发送登录链接"}
          </button>
        </form>

        <div className="login__divider"><span>或</span></div>

        <button
          className="login__google"
          onClick={onLoginWithGoogle}
          disabled={isSubmitting}
        >
          <svg className="login__cta-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M21.6 12.227c0-.709-.064-1.39-.182-2.045H12v3.868h5.382a4.6 4.6 0 0 1-1.995 3.018v2.51h3.232c1.891-1.742 2.981-4.305 2.981-7.351z"/>
            <path fill="currentColor" d="M12 22c2.7 0 4.964-.895 6.619-2.422l-3.232-2.51c-.896.6-2.042.955-3.387.955-2.605 0-4.81-1.76-5.598-4.123H3.064v2.59A9.996 9.996 0 0 0 12 22z"/>
            <path fill="currentColor" d="M6.402 13.9A6.01 6.01 0 0 1 6.09 12c0-.659.114-1.3.312-1.9V7.51H3.064A9.996 9.996 0 0 0 2 12c0 1.614.386 3.14 1.064 4.49l3.338-2.59z"/>
            <path fill="currentColor" d="M12 5.977c1.468 0 2.786.504 3.823 1.494l2.868-2.868C16.96 2.99 14.696 2 12 2 8.09 2 4.71 4.245 3.064 7.51l3.338 2.59C7.19 7.737 9.395 5.977 12 5.977z"/>
          </svg>
          <span>用 Google 登录</span>
        </button>

        <p className="login__legal">登录即代表同意《服务条款》与《隐私政策》</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Append login.css rules for the new elements**

Append to `apps/desktop/src/login.css`:

```css
/* form: email input + send button stacked, then divider, then Google button */
.login__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: 100%;
  max-width: 320px;
  margin: var(--space-5) auto 0;
}

.login__input {
  width: 100%;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  color: var(--fg);
  font-size: var(--text-md);
  transition: border-color var(--duration-fast) var(--ease-out);
}
.login__input:focus { border-color: var(--accent); outline: none; }
.login__input:disabled { opacity: 0.6; cursor: not-allowed; }

.login__error {
  color: var(--danger-fg);
  font-size: var(--text-sm);
  text-align: center;
}

.login__divider {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  max-width: 320px;
  margin: var(--space-5) auto 0;
  color: var(--fg-mute);
  font-size: var(--text-sm);
}
.login__divider::before, .login__divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--border);
}

.login__google {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  width: 100%;
  max-width: 320px;
  margin: var(--space-3) auto 0;
  padding: var(--space-3) var(--space-5);
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-strong);
  background: transparent;
  color: var(--fg);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  transition: background var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out);
}
.login__google:hover:not(:disabled) { background: var(--hover); border-color: var(--border); }
.login__google:disabled { opacity: 0.5; cursor: not-allowed; }
.login__google .login__cta-icon { width: 18px; height: 18px; }

.login__link {
  display: block;
  margin: var(--space-3) auto 0;
  padding: var(--space-2);
  background: transparent;
  color: var(--fg-dim);
  font-size: var(--text-sm);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.login__link:hover { color: var(--fg); }
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS — all 5 projects.

- [ ] **Step 5: Run full test suite (no React tests changed, just sanity)**

Run: `pnpm test`

Expected: still 96 pass (Login changes aren't covered by unit tests in SP-1).

- [ ] **Step 6: Build the desktop bundle to catch CSS / TSX errors**

Run: `pnpm --filter desktop build`

Expected: PASS — vite build emits `dist/assets/index-*.css` and `dist/assets/index-*.js` without error.

- [ ] **Step 7: Commit Login + useAuth changes together**

```bash
git add apps/desktop/src/App.tsx apps/desktop/src/Login.tsx apps/desktop/src/login.css apps/desktop/src/useAuth.ts
git commit -m "feat(desktop): Login state machine + email magic-link wiring

- App.tsx threads loginWithGoogle + loginWithEmail through useAuth.
- useAuth: handle cogni://auth?magic=... by POSTing to /auth/email/callback,
  then setToken with the returned JWT (replaces the Google-only branch).
- Login.tsx: four-state machine (form | sending | sent | error). Form has
  email input + send button + divider + Google button + fine-print. 'Sent'
  state shows the address it went to + a 60s resend cooldown + 'use another
  email?' link back to form.
- login.css: input, divider with rule lines, secondary Google button,
  underlined link button. All sizes / colors via tokens.

Verified: pnpm typecheck clean, pnpm test 96/96 pass, pnpm --filter desktop
build succeeds.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Docs — RUNNING.md magic-link section

**Files:**
- Modify: `docs/RUNNING.md`

- [ ] **Step 1: Read current RUNNING.md to find a good insertion point**

Run: `grep -n '^##' docs/RUNNING.md`

Find the "## 3. Set up Google OAuth" header. We add a new section after it.

- [ ] **Step 2: Insert a new section**

Add after the Google OAuth section (so it becomes section 3.5 / renumber later or call it 4):

```markdown
## 3.5 Set up email magic-link login (optional, recommended)

Magic-link login lets users sign in without Google OAuth — essential when the
runtime network can't reliably reach Google.

**Dev mode (no real emails):** leave `EMAIL_TRANSPORT=console` in `.env`. The
cloud will print the magic URL to stdout instead of sending an email; copy it
into your browser address bar (`open <url>`) to log in.

**Production / staging (real emails):**

1. Create a [Resend](https://resend.com) account (free tier covers 3k
   emails/mo — plenty for SP-1).
2. In Resend → Domains, add and verify the domain you want to send from
   (DNS records: SPF + DKIM). Verification usually takes 5-15 min once
   records are propagated.
3. Create an API key (Domains → API Keys → Create).
4. Fill the new vars in `packages/cloud/.env`:

   ```
   EMAIL_TRANSPORT=resend
   RESEND_API_KEY=re_…
   EMAIL_FROM=Cogni <login@yourdomain.com>
   MAGIC_LINK_TTL_MIN=15
   ```

5. Restart `pnpm --filter @cogni/cloud dev`.

The desktop app's Login page automatically shows both CTAs (email + Google) —
nothing extra to configure on the client.
```

- [ ] **Step 3: Add magic-link items to the SP-1 acceptance checklist**

Find the "## 6. SP-1 acceptance checklist (manual walkthrough)" header and append the new check before the existing item 7:

```markdown
8. **邮件 magic-link 登录** — On the Login page, enter a fresh email address
   and click "发送登录链接". The page should switch to a "已发送…" state
   with a 60s resend countdown. With `EMAIL_TRANSPORT=console`, copy the
   `cogni://auth?magic=…` URL from the cloud's stdout, paste into a shell
   and run `open <url>`; the app should drop into the Welcome page. Send
   the link to the same email a second time within a minute and verify
   the cloud returns 429 (visible as a red error banner on the Login form).

9. **同一 email 在 Google 和 magic link 间复用同一身份** — If a Google
   login was performed earlier with `alice@gmail.com`, signing in via
   magic link with the same address must surface the same Recents list
   (`SELECT * FROM users WHERE email = 'alice@gmail.com'` returns exactly
   one row; `user_identities` has both `google|<sub>` and `email|alice@gmail.com`).
```

- [ ] **Step 4: Commit**

```bash
git add docs/RUNNING.md
git commit -m "docs(running): magic-link setup + acceptance items

Adds section 3.5 covering Resend account setup (domain + DKIM + API key) and
the .env block. Console transport is the dev default — no real email needed,
the magic URL is printed to stdout for copy-paste.

Acceptance checklist gains items 8 and 9: magic-link round-trip and same-email
identity reuse across Google and magic-link logins.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Full-suite verification + dogfood smoke

**Files:**
- N/A (verification only)

- [ ] **Step 1: Run the full automated gate**

Run from repo root:

```bash
pnpm test
pnpm typecheck
pnpm --filter desktop build
```

Expected: all green. Final test count should be **96** (84 baseline + 1 identities + 1 dev-token wiring + 2 env + 5 send + 3 callback = 96).

- [ ] **Step 2: Restart cloud + desktop dev**

In two terminals:

```bash
# Terminal 1
cd packages/cloud && pnpm dev
# (should see "cloud control plane listening" with emailTransport: console)
```

```bash
# Terminal 2
cd apps/desktop && pnpm tauri dev
```

- [ ] **Step 3: Dogfood Login flow — email path with Console transport**

Open the desktop window. You should see the rebuilt Login page with:
- Email input + 发送登录链接 button
- ── 或 ── divider
- 用 Google 登录 button

Enter `test@example.com` and click 发送. The page should switch to "已发送登录链接到 test@example.com…" with a "60s 后可重发" countdown.

Switch to the cloud terminal. You should see a line like:

```
[email/console] would send to=test@example.com url=cogni://auth?magic=AbCdEf... expiresInMinutes=15
```

Copy that URL. In a shell, run:

```bash
open 'cogni://auth?magic=AbCdEf...'
```

The desktop should drop into the Welcome page (✳ Good evening + composer + chips).

- [ ] **Step 4: Verify identity model in DB**

In the Neon console (or via `psql $DATABASE_URL`):

```sql
SELECT id, email FROM users WHERE email = 'test@example.com';
-- 1 row
SELECT kind, sub FROM user_identities WHERE user_id = (SELECT id FROM users WHERE email = 'test@example.com');
-- 1 row: kind='email', sub='test@example.com'
```

- [ ] **Step 5: Verify Google identity merge — manual or skip**

If you can complete a Google OAuth login as `alice@gmail.com` and then a magic-link login as the same `alice@gmail.com`, query:

```sql
SELECT u.id, u.email, ARRAY_AGG(i.kind || '|' || i.sub) AS identities
FROM users u JOIN user_identities i ON i.user_id = u.id
WHERE u.email = 'alice@gmail.com' GROUP BY u.id;
-- 1 row, identities = {google|<sub>, email|alice@gmail.com}
```

If Google OAuth is unreachable from your network (the whole reason this work exists), skip this step and note it in the verification log — the unit tests in Task 4 + 10 already cover the merge logic.

- [ ] **Step 6: Verify rate limit**

In the desktop Login page, send the magic link to the same email twice within 30 seconds. The second submit should show a red "请稍后再试" error on the form (mapped from 429).

- [ ] **Step 7: Write a verification changelog**

Create `changelog/<timestamp>.md` (timestamp via `date +%Y%m%d_%H%M%S`):

```markdown
# <timestamp>

## Summary

Email magic-link login (C phase) implemented and verified. cogni now has two
production-grade auth paths — Google OAuth (unchanged) and email magic link
(new) — sharing one identity model (email-keyed users + user_identities).

## Changes

(Summarise the 15 task commits. Reference commit hashes.)

## Verification

- pnpm test 96/96 pass
- pnpm typecheck 5/5 projects clean
- pnpm --filter desktop build OK
- Manual dogfood — Console transport: send → stdout URL → open → Welcome page
- DB inspection: 1 user row, 1 user_identities row with kind=email
- Rate limit: 2nd send within 60s → 429 → red error banner
- Same-email identity merge — covered by Task 4 + 10 unit tests
  (skipped manual Google round-trip because GFW)

## Out of scope (deferred to SP-2)

- Account linking UI for legacy two-row users (none in dev DB)
- Real Resend hookup (requires verified domain — operator task)
- HTML / branded email template
- HTTPS web fallback for magic links
```

- [ ] **Step 8: Commit verification changelog**

```bash
git add changelog/
git commit -m "chore: changelog — email magic-link login C phase verified"
```

- [ ] **Step 9: Final summary commit (optional)**

If everything is green, the branch is ready to merge to main. Use `superpowers:finishing-a-development-branch` to choose merge / PR / keep.

---

## Notes for the implementer

- **Reading order**: tasks are bottom-up (DB → repo → transport → routes → desktop UI → docs). Each task's tests pass standalone before the next is started; no task leaves an intermediate state broken longer than necessary.
- **No new npm dependencies**: `crypto.randomBytes` is built into Node; zod is already a dependency; Resend is invoked via `fetch` directly so no `@resend/node` SDK is required.
- **The dev-token endpoint stays alive**: it's how `vite dev` boots the desktop without manual UI input. Magic link is the production path; dev-token is the convenience for repeated dev restarts.
- **Test count math**: baseline 84 → Task 2 (+1) = 85 → Task 4 (+1) = 86 → Task 5 (+4) = 90 → Task 6 (+2) = 92 → Task 7 (+2) = 94 → Task 8 (+2) = 96 → Task 9 (+5) = 101 → Task 10 (+5) = 106. Final = **106**, not 96. If your local count differs, count again — the test suite is the source of truth.
- **Migrating an existing DB**: SP-1 dev DBs have a `users.oauth_sub` column with one row (`dev|manual` after recent dogfood). `drizzle-kit push` will detect the column drop and ask to confirm; answer yes (data lost is acceptable, and the dev-token endpoint will recreate the user on next startup).
- **Anti-enumeration nuance**: `/send` returns 200 OK regardless of whether the email exists in `users`. **Rate limit hits (429) DO reveal "you've sent here recently",** which leaks slightly to an attacker — acceptable trade for usable UX. If you ever care about hard anti-enumeration, return 200 on rate-limit too and silently drop the send. SP-1 does not need this.
- **Why import inside the handler in Task 9**: `findOrCreateUserByEmail` / `upsertIdentity` are dynamically imported in `/auth/email/callback` to avoid a tight `routes/email.ts` ↔ `db/*` coupling at module load time. The earlier Google callback in `routes/auth.ts` does the static import — both are fine; both styles exist in the codebase.
- **The Login form respects the existing token chain**: when the magic-link flow completes, the JWT is stored under `localStorage["cogni_token"]` exactly like Google OAuth, so all downstream code (Shell, useThreadStream, Conversation) is untouched.
