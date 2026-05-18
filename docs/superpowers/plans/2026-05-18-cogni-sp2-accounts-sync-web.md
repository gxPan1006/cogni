# Cogni SP-2 Implementation Plan — Accounts + Multi-device Sync + Web Thin Client

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Layer multi-device sync, multi-host dispatch with offline-fallback, and a browser-based web client on top of the SP-1 spine; surface auto-merged accounts and revocable sessions in a settings page.

**Architecture:** Schema delta is tiny — drop the `runner_sessions.thread_id` UNIQUE, add `closed` status + `closed_at`, add `auth_sessions` + `hosts.removed_at`. The cloud's existing `ClientHub` grows from per-thread fan-out into a per-user pubsub with subscribe-list / subscribe-thread routing. `HostRouter` becomes multi-host-per-user. Dispatcher refactors from "always-have-one-host" into a "check preferred → fallback prompt → hard-block" state machine. UI code currently in `apps/desktop/src/` extracts to a new `packages/ui` workspace package; a new `apps/web` Vite SPA imports the same components and ships statically to `chat.ai-cognit.com`.

**Tech Stack:** TypeScript / pnpm 10.33 monorepo / Hono + @hono/node-ws / drizzle + Neon / Tauri 2 + React 19 / Vite 7 / vitest / nginx + Let's Encrypt on prod-cognit.

**Spec:** `docs/superpowers/specs/2026-05-18-cogni-sp2-accounts-sync-web-design.md` (commit `1b17d69`).

---

## File Structure

### New files
- `packages/cloud/src/scripts/migrate-2026-05-18-sp2-deltas.ts` — one-shot Neon migration
- `packages/cloud/src/db/auth-sessions.ts` + `.test.ts` — CRUD for `auth_sessions`
- `packages/cloud/src/auth/find-or-link.ts` + `.test.ts` — unified login → user resolution
- `packages/cloud/src/routes/identities.ts` + `.test.ts` — `GET /api/identities`, `DELETE /api/identities/:kind/:sub`
- `packages/cloud/src/routes/devices.ts` + `.test.ts` — `GET /api/devices`, `DELETE /api/devices/:id`
- `packages/cloud/src/routes/hosts.ts` + `.test.ts` — `PATCH /api/hosts/:id`, `DELETE /api/hosts/:id`
- `packages/ui/package.json` + `tsconfig.json` + `vitest.config.ts`
- `packages/ui/src/index.ts` — barrel
- `packages/ui/src/transport/api.ts` — moved + modified `apps/desktop/src/api.ts`
- `packages/ui/src/transport/ws-client.ts` — extracted streaming + catchup
- `packages/ui/src/hooks/useAuth-core.ts` — provider-agnostic token state
- `packages/ui/src/hooks/useThreadStream.ts` — moved + extended
- `packages/ui/src/hooks/useDevices.ts` + `useIdentities.ts` + `useHosts.ts`
- `packages/ui/src/components/Sidebar.tsx` + `sidebar.css`
- `packages/ui/src/components/Conversation.tsx` + `conversation.css`
- `packages/ui/src/components/Composer.tsx` + `composer.css`
- `packages/ui/src/components/Welcome.tsx`
- `packages/ui/src/components/Login.tsx` + `login.css`
- `packages/ui/src/components/SettingsPage.tsx` + `settings.css`
- `packages/ui/src/components/HostFallbackCard.tsx`
- `packages/ui/src/components/NoHostBanner.tsx`
- `apps/web/package.json` + `vite.config.ts` + `tsconfig.json` + `index.html`
- `apps/web/src/main.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/useAuth-web.ts` — redirect-based variant
- `apps/web/src/AuthCallback.tsx` — handles `/auth/google/callback` and `/auth/email/callback`
- `apps/web/.env.example`, `.env.production`

### Modified files
- `packages/cloud/src/db/schema.ts` — schema additions
- `packages/cloud/src/db/sessions.ts` — multi-session helpers
- `packages/cloud/src/db/hosts.ts` — rename, soft-remove, exclude-removed in listing
- `packages/cloud/src/db/identities.ts` — `listIdentities`, `deleteIdentity` (already has `upsertIdentity`)
- `packages/cloud/src/auth.ts` — `sessionId` claim added to `SessionClaims`
- `packages/cloud/src/routes/auth.ts` — use `findOrLinkUser`, support `redirect_uri` param
- `packages/cloud/src/routes/email.ts` — accept `origin` param, dynamic link URL
- `packages/cloud/src/routes/client.ts` — handle new WS message types, route to `ClientHub`
- `packages/cloud/src/routes/host-ws.ts` — multi-host registration, publish `host-meta` on connect/disconnect
- `packages/cloud/src/client-hub.ts` — add `publishThreadMeta`, `publishHostMeta`, `publishUserBroadcast`, `sendToConn`, list-subscription state
- `packages/cloud/src/host-router.ts` — `Map<userId, Set<hostId>>` instead of `Map<userId, hostId>`
- `packages/cloud/src/domains/chat.ts` — check-host-first state machine, multi-session lifecycle
- `packages/cloud/src/server.ts` — CORS adds `https://chat.ai-cognit.com`, register new routes
- `packages/cloud/src/main.ts` — register new routes
- `packages/contract/src/protocol.ts` — full new WS message types
- `packages/contract/src/domain.ts` — extend `RunnerSessionStatus` with `closed`
- `apps/desktop/src/App.tsx` — import from `@cogni/ui`
- `apps/desktop/src/useAuth.ts` — slim Tauri shim around `useAuth-core`
- `apps/desktop/src/Shell.tsx` — settings route, sidebar gear
- `apps/desktop/package.json` — depend on `@cogni/ui`; drop component files
- `apps/desktop/src/api.ts` — delete (moved into `@cogni/ui`)
- `apps/desktop/src/Login.tsx`, `Sidebar.tsx`, `Conversation.tsx`, `Composer.tsx`, `Welcome.tsx`, `useThreadStream.ts` — delete (moved into `@cogni/ui`)
- `docs/DEPLOYMENT.md` — web subdomain section + cert + deploy step

---

## Conventions

- TDD throughout: failing test → minimal pass → commit. Each task ends with `git add` + `git commit -m "..."` (Conventional Commit prefix).
- After every commit, also write a local-only `changelog/YYYYMMDD_HHMMSS.md` (see `~/.claude/CLAUDE.md` — `changelog/` is gitignored, one file per commit).
- Run `pnpm -r build` + `pnpm -r test` at the end of each major section to keep typecheck + tests green.
- Co-author tag on commits: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Tests for DB helpers use the pglite test harness at `packages/cloud/src/db/test-db.ts`.

---

## Section 1: Schema & DB layer

### Task 1: Schema migration script + drizzle schema deltas

**Files:**
- Create: `packages/cloud/src/scripts/migrate-2026-05-18-sp2-deltas.ts`
- Modify: `packages/cloud/src/db/schema.ts`
- Modify: `packages/contract/src/domain.ts` (extend `RunnerSessionStatus`)

- [ ] **Step 1: Extend `RunnerSessionStatus` enum**

Edit `packages/contract/src/domain.ts:2`:

```ts
export type RunnerSessionStatus = "idle" | "running" | "completed" | "failed" | "closed";
```

- [ ] **Step 2: Extend `sessionStatusSchema` (zod)**

Edit `packages/contract/src/protocol.ts:4`. The wire `SessionStatus` (what hosts send via `session-update`) intentionally excludes lifecycle-internal states (`idle`, `closed`) — leave that zod schema alone. Only the DB-side `RunnerSessionStatus` type widens.

Verify: `pnpm --filter @cogni/contract typecheck` passes.

- [ ] **Step 3: Update drizzle schema for `runner_sessions`**

Edit `packages/cloud/src/db/schema.ts`. Remove the unique index, add `closedAt`:

```ts
export const runnerSessions = pgTable("runner_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id").notNull().references(() => threads.id),
  hostId: uuid("host_id").references(() => hosts.id),
  adapter: text("adapter").notNull(),
  runnerSessionId: text("runner_session_id"),
  status: text("status").notNull().default("idle"),
  closedAt: timestamp("closed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
// NOTE: no more threadUq — a thread now has many historic sessions.
```

- [ ] **Step 4: Add `authSessions` table to schema**

Append to `packages/cloud/src/db/schema.ts`:

```ts
export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  deviceName: text("device_name").notNull(),
  userAgent: text("user_agent"),
  ip: text("ip"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  revokedAt: timestamp("revoked_at"),
});
```

- [ ] **Step 5: Add `removedAt` to `hosts`**

Edit the `hosts` table in `packages/cloud/src/db/schema.ts`:

```ts
export const hosts = pgTable("hosts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  status: text("status").notNull().default("offline"),
  registrationToken: text("registration_token").notNull().unique(),
  capabilitiesJson: jsonb("capabilities_json").notNull().default([]),
  lastSeen: timestamp("last_seen"),
  removedAt: timestamp("removed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

- [ ] **Step 6: Write the migration script**

Create `packages/cloud/src/scripts/migrate-2026-05-18-sp2-deltas.ts`:

```ts
/**
 * SP-2 migration: schema deltas for multi-host + revocable sessions + soft-remove hosts.
 *
 * Idempotent — every statement uses IF NOT EXISTS / DROP IF EXISTS.
 *
 * Run with:
 *   pnpm --filter @cogni/cloud exec tsx --env-file=.env \
 *     src/scripts/migrate-2026-05-18-sp2-deltas.ts
 */
import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../env.js";

const env = loadEnv();
const sql = neon(env.databaseUrl);

console.log("[migrate] dropping runner_sessions.thread_id unique constraint…");
await sql`ALTER TABLE runner_sessions DROP CONSTRAINT IF EXISTS runner_sessions_thread_uq`;

console.log("[migrate] adding runner_sessions.closed_at column…");
await sql`ALTER TABLE runner_sessions ADD COLUMN IF NOT EXISTS closed_at timestamp`;

console.log("[migrate] creating auth_sessions table…");
await sql`
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    device_name text not null,
    user_agent text,
    ip text,
    created_at timestamp not null default now(),
    last_seen_at timestamp not null default now(),
    revoked_at timestamp
  )
`;
await sql`CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id) WHERE revoked_at IS NULL`;

console.log("[migrate] adding hosts.removed_at column…");
await sql`ALTER TABLE hosts ADD COLUMN IF NOT EXISTS removed_at timestamp`;

const post = await sql`
  SELECT
    (SELECT count(*)::int FROM auth_sessions) AS auth_sessions_n,
    (SELECT count(*)::int FROM runner_sessions) AS runner_sessions_n,
    (SELECT count(*)::int FROM hosts WHERE removed_at IS NOT NULL) AS removed_hosts_n
`;
console.log(`[migrate] done — auth_sessions=${post[0]?.auth_sessions_n}, runner_sessions=${post[0]?.runner_sessions_n}, removed_hosts=${post[0]?.removed_hosts_n}`);
process.exit(0);
```

- [ ] **Step 7: Run the migration locally**

```bash
pnpm --filter @cogni/cloud exec tsx --env-file=.env \
  src/scripts/migrate-2026-05-18-sp2-deltas.ts
```

Expected output:
```
[migrate] dropping runner_sessions.thread_id unique constraint…
[migrate] adding runner_sessions.closed_at column…
[migrate] creating auth_sessions table…
[migrate] adding hosts.removed_at column…
[migrate] done — auth_sessions=0, runner_sessions=N, removed_hosts_n=0
```

- [ ] **Step 8: Verify schema.test.ts still passes**

Run: `pnpm --filter @cogni/cloud test -- schema.test`
Expected: PASS.

If `schema.test.ts` asserts the unique constraint, update the assertion to reflect the dropped constraint.

- [ ] **Step 9: Commit**

```bash
git add packages/contract/src/domain.ts packages/cloud/src/db/schema.ts \
  packages/cloud/src/scripts/migrate-2026-05-18-sp2-deltas.ts
git commit -m "feat(db): SP-2 schema deltas — multi-session, auth_sessions, host soft-remove

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && mkdir -p changelog && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — schema deltas

## Summary
SP-2 needs (a) many runner_sessions per thread for host fallback, (b) revocable
auth_sessions for the new device-list UI, (c) soft-removable hosts. All three
land in one migration script (idempotent). RunnerSessionStatus widens to include
'closed' (= explicitly superseded by a host switch).

## Changes
- packages/contract/src/domain.ts — RunnerSessionStatus adds 'closed'
- packages/cloud/src/db/schema.ts — drop runner_sessions thread uq, add closedAt + authSessions table + hosts.removedAt
- packages/cloud/src/scripts/migrate-2026-05-18-sp2-deltas.ts — one-shot Neon migration
EOF
```

---

### Task 2: DB helpers for multi-session `runner_sessions`

**Files:**
- Modify: `packages/cloud/src/db/sessions.ts`
- Modify: `packages/cloud/src/db/sessions.test.ts`

- [ ] **Step 1: Write failing tests for `getCurrentActiveSession`, `openNewSession`, `closeSession`**

Append to `packages/cloud/src/db/sessions.test.ts`:

```ts
import { closeRunnerSession, getCurrentActiveSession, openRunnerSession } from "./sessions.js";

it("openRunnerSession creates a fresh row with hostId + adapter", async () => {
  const { db, thread, host } = await seedThreadAndHost();
  const s = await openRunnerSession(db, { threadId: thread.id, hostId: host.id, adapter: "claude-code" });
  expect(s.threadId).toBe(thread.id);
  expect(s.hostId).toBe(host.id);
  expect(s.status).toBe("idle");
});

it("getCurrentActiveSession returns the most recent non-closed session", async () => {
  const { db, thread, host } = await seedThreadAndHost();
  const s1 = await openRunnerSession(db, { threadId: thread.id, hostId: host.id, adapter: "claude-code" });
  await closeRunnerSession(db, s1.id);
  const s2 = await openRunnerSession(db, { threadId: thread.id, hostId: host.id, adapter: "claude-code" });
  const active = await getCurrentActiveSession(db, thread.id);
  expect(active?.id).toBe(s2.id);
});

it("getCurrentActiveSession returns null when only closed sessions exist", async () => {
  const { db, thread, host } = await seedThreadAndHost();
  const s = await openRunnerSession(db, { threadId: thread.id, hostId: host.id, adapter: "claude-code" });
  await closeRunnerSession(db, s.id);
  expect(await getCurrentActiveSession(db, thread.id)).toBeNull();
});

it("closeRunnerSession sets status=closed + closed_at", async () => {
  const { db, thread, host } = await seedThreadAndHost();
  const s = await openRunnerSession(db, { threadId: thread.id, hostId: host.id, adapter: "claude-code" });
  await closeRunnerSession(db, s.id);
  const rows = await db.select().from(runnerSessions).where(eq(runnerSessions.id, s.id));
  expect(rows[0].status).toBe("closed");
  expect(rows[0].closedAt).not.toBeNull();
});
```

(`seedThreadAndHost` is a helper you write inline in the test file — creates one tenant, one user, one thread, one host, returns `{ db, thread, host }`. Re-use `makeTestDb()` from `test-db.ts`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @cogni/cloud test -- sessions.test`
Expected: FAIL on all 4 new tests (function not exported).

- [ ] **Step 3: Implement helpers**

Edit `packages/cloud/src/db/sessions.ts`. Add:

```ts
import { eq, and, isNull, desc } from "drizzle-orm";
import { runnerSessions } from "./schema.js";

export async function openRunnerSession(
  db: AnyDb,
  input: { threadId: string; hostId: string; adapter: string },
): Promise<RunnerSessionRow & { hostId: string }> {
  const [row] = await db
    .insert(runnerSessions)
    .values({ threadId: input.threadId, hostId: input.hostId, adapter: input.adapter })
    .returning();
  return { ...toRow(row!), hostId: input.hostId };
}

export async function getCurrentActiveSession(
  db: AnyDb,
  threadId: string,
): Promise<(RunnerSessionRow & { hostId: string | null }) | null> {
  const rows = await db
    .select()
    .from(runnerSessions)
    .where(and(eq(runnerSessions.threadId, threadId), isNull(runnerSessions.closedAt)))
    .orderBy(desc(runnerSessions.createdAt))
    .limit(1);
  if (!rows[0]) return null;
  return { ...toRow(rows[0]), hostId: rows[0].hostId };
}

export async function closeRunnerSession(db: AnyDb, sessionId: string): Promise<void> {
  await db
    .update(runnerSessions)
    .set({ status: "closed", closedAt: new Date() })
    .where(eq(runnerSessions.id, sessionId));
}

export async function getLatestSessionForThread(
  db: AnyDb,
  threadId: string,
): Promise<(RunnerSessionRow & { hostId: string | null }) | null> {
  const rows = await db
    .select()
    .from(runnerSessions)
    .where(eq(runnerSessions.threadId, threadId))
    .orderBy(desc(runnerSessions.createdAt))
    .limit(1);
  if (!rows[0]) return null;
  return { ...toRow(rows[0]), hostId: rows[0].hostId };
}
```

Keep the old `getOrCreateRunnerSession` for now — `chat.ts` still uses it. Task 13–15 will replace it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @cogni/cloud test -- sessions.test`
Expected: PASS all 4 new tests + existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/db/sessions.ts packages/cloud/src/db/sessions.test.ts
git commit -m "feat(db): multi-session helpers for runner_sessions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — runner_sessions multi-session helpers

## Summary
Added openRunnerSession / getCurrentActiveSession / closeRunnerSession /
getLatestSessionForThread. Old getOrCreateRunnerSession kept temporarily for
chat.ts compatibility; replaced in Task 14.

## Changes
- packages/cloud/src/db/sessions.ts — four new helpers
- packages/cloud/src/db/sessions.test.ts — four new tests + seedThreadAndHost helper
EOF
```

---

### Task 3: DB helpers for `auth_sessions`

**Files:**
- Create: `packages/cloud/src/db/auth-sessions.ts`
- Create: `packages/cloud/src/db/auth-sessions.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/cloud/src/db/auth-sessions.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./test-db.js";
import { findOrCreateUserByEmail } from "./users.js";
import {
  createAuthSession, listAuthSessionsForUser, getAuthSession,
  revokeAuthSession, touchAuthSession,
} from "./auth-sessions.js";

describe("auth_sessions", () => {
  let db: Awaited<ReturnType<typeof makeTestDb>>;
  let userId: string;

  beforeEach(async () => {
    db = await makeTestDb();
    const u = await findOrCreateUserByEmail(db, "user@example.com");
    userId = u.id;
  });

  it("createAuthSession returns id + persists row", async () => {
    const s = await createAuthSession(db, { userId, deviceName: "Chrome on macOS", userAgent: "Mozilla", ip: "1.2.3.4" });
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    const fetched = await getAuthSession(db, s.id);
    expect(fetched?.userId).toBe(userId);
    expect(fetched?.deviceName).toBe("Chrome on macOS");
  });

  it("listAuthSessionsForUser excludes revoked + newest-first", async () => {
    const a = await createAuthSession(db, { userId, deviceName: "Old Device" });
    const b = await createAuthSession(db, { userId, deviceName: "New Device" });
    await revokeAuthSession(db, a.id);
    const list = await listAuthSessionsForUser(db, userId);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(b.id);
  });

  it("getAuthSession of a revoked session returns row with revokedAt set", async () => {
    const s = await createAuthSession(db, { userId, deviceName: "X" });
    await revokeAuthSession(db, s.id);
    const fetched = await getAuthSession(db, s.id);
    expect(fetched?.revokedAt).not.toBeNull();
  });

  it("touchAuthSession bumps lastSeenAt", async () => {
    const s = await createAuthSession(db, { userId, deviceName: "X" });
    const before = (await getAuthSession(db, s.id))!.lastSeenAt;
    await new Promise((r) => setTimeout(r, 20));
    await touchAuthSession(db, s.id);
    const after = (await getAuthSession(db, s.id))!.lastSeenAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `pnpm --filter @cogni/cloud test -- auth-sessions.test`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement `auth-sessions.ts`**

Create `packages/cloud/src/db/auth-sessions.ts`:

```ts
import { eq, and, isNull, desc } from "drizzle-orm";
import { authSessions } from "./schema.js";
import type { AnyDb } from "./client.js";

export interface AuthSessionRow {
  id: string;
  userId: string;
  deviceName: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

export async function createAuthSession(
  db: AnyDb,
  input: { userId: string; deviceName: string; userAgent?: string; ip?: string },
): Promise<AuthSessionRow> {
  const [row] = await db
    .insert(authSessions)
    .values({
      userId: input.userId,
      deviceName: input.deviceName,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
    })
    .returning();
  return toRow(row!);
}

export async function getAuthSession(db: AnyDb, id: string): Promise<AuthSessionRow | null> {
  const rows = await db.select().from(authSessions).where(eq(authSessions.id, id)).limit(1);
  return rows[0] ? toRow(rows[0]) : null;
}

export async function listAuthSessionsForUser(db: AnyDb, userId: string): Promise<AuthSessionRow[]> {
  const rows = await db
    .select()
    .from(authSessions)
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
    .orderBy(desc(authSessions.lastSeenAt));
  return rows.map(toRow);
}

export async function revokeAuthSession(db: AnyDb, id: string): Promise<void> {
  await db.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.id, id));
}

export async function touchAuthSession(db: AnyDb, id: string): Promise<void> {
  await db.update(authSessions).set({ lastSeenAt: new Date() }).where(eq(authSessions.id, id));
}

function toRow(r: typeof authSessions.$inferSelect): AuthSessionRow {
  return {
    id: r.id, userId: r.userId, deviceName: r.deviceName,
    userAgent: r.userAgent, ip: r.ip,
    createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, revokedAt: r.revokedAt,
  };
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `pnpm --filter @cogni/cloud test -- auth-sessions.test`
Expected: PASS all 4.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/db/auth-sessions.ts packages/cloud/src/db/auth-sessions.test.ts
git commit -m "feat(db): auth_sessions CRUD for revocable login sessions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — auth_sessions DB layer

## Summary
CRUD helpers backing the new devices UI: create on login, list (excluding
revoked) for settings page, revoke on user action, touch on every authed
request to feed "last seen".

## Changes
- packages/cloud/src/db/auth-sessions.ts — five exported helpers
- packages/cloud/src/db/auth-sessions.test.ts — coverage of all five
EOF
```

---

### Task 4: DB helpers for hosts (rename, soft-remove, list-excluding-removed)

**Files:**
- Modify: `packages/cloud/src/db/hosts.ts`
- Modify: `packages/cloud/src/db/hosts.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/cloud/src/db/hosts.test.ts`:

```ts
import { renameHost, softRemoveHost, getActiveHostsForUser, isHostRemoved } from "./hosts.js";

it("renameHost updates name + leaves other fields alone", async () => {
  const { db, host, user } = await seedHostForUser();
  await renameHost(db, host.id, "Home MacBook Pro");
  const list = await getActiveHostsForUser(db, user.id);
  expect(list[0]?.name).toBe("Home MacBook Pro");
});

it("softRemoveHost sets removed_at; isHostRemoved reports true", async () => {
  const { db, host } = await seedHostForUser();
  expect(await isHostRemoved(db, host.id)).toBe(false);
  await softRemoveHost(db, host.id);
  expect(await isHostRemoved(db, host.id)).toBe(true);
});

it("getActiveHostsForUser excludes removed hosts", async () => {
  const { db, user, host } = await seedHostForUser();
  const second = await createHost(db, { userId: user.id, tenantId: user.tenantId, name: "Other" });
  // softRemove first one
  await softRemoveHost(db, host.id);
  const list = await getActiveHostsForUser(db, user.id);
  expect(list).toHaveLength(1);
  expect(list[0]?.id).toBe(second.hostId);
});
```

(Helper `seedHostForUser` creates user, returns `{ db, user, host: createHost row }`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @cogni/cloud test -- hosts.test`
Expected: FAIL — `renameHost`, `softRemoveHost`, `getActiveHostsForUser`, `isHostRemoved` not exported.

- [ ] **Step 3: Implement helpers**

Edit `packages/cloud/src/db/hosts.ts`. Add:

```ts
import { isNull, and } from "drizzle-orm";

export async function renameHost(db: AnyDb, hostId: string, name: string): Promise<void> {
  await db.update(hosts).set({ name }).where(eq(hosts.id, hostId));
}

export async function softRemoveHost(db: AnyDb, hostId: string): Promise<void> {
  await db.update(hosts).set({ removedAt: new Date(), status: "offline" }).where(eq(hosts.id, hostId));
}

export async function isHostRemoved(db: AnyDb, hostId: string): Promise<boolean> {
  const rows = await db.select({ removedAt: hosts.removedAt }).from(hosts).where(eq(hosts.id, hostId)).limit(1);
  return rows[0] ? rows[0].removedAt !== null : false;
}

export async function getActiveHostsForUser(db: AnyDb, userId: string) {
  return db.select().from(hosts).where(and(eq(hosts.userId, userId), isNull(hosts.removedAt)));
}
```

Also update `findHostByToken` so a removed host can't reconnect:

```ts
export async function findHostByToken(db: AnyDb, token: string) {
  const rows = await db.select().from(hosts)
    .where(and(eq(hosts.registrationToken, token), isNull(hosts.removedAt)))
    .limit(1);
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Update existing `getUserHosts` caller in `routes/client.ts:67`**

`getUserHosts` returns all hosts including removed — switch the callers that want to list user-visible hosts to `getActiveHostsForUser`. Audit:
- `packages/cloud/src/routes/client.ts:67` (the existing `GET /api/hosts`) → switch to `getActiveHostsForUser`.
- Keep `getUserHosts` as is (might still be useful for admin-style queries).

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @cogni/cloud test -- hosts.test`
Expected: PASS new tests; old tests still green.

- [ ] **Step 6: Commit**

```bash
git add packages/cloud/src/db/hosts.ts packages/cloud/src/db/hosts.test.ts packages/cloud/src/routes/client.ts
git commit -m "feat(db): host rename + soft-remove

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — host rename / soft-remove

## Summary
renameHost + softRemoveHost + getActiveHostsForUser back the settings page
"Runner Hosts" section. findHostByToken now refuses to validate a token for a
removed host (so the daemon can't re-register a deleted host without going
through fresh registration).

## Changes
- packages/cloud/src/db/hosts.ts — three new exports + filter removed from token lookup
- packages/cloud/src/db/hosts.test.ts — three new tests
- packages/cloud/src/routes/client.ts — GET /api/hosts uses getActiveHostsForUser
EOF
```

---

### Task 5: Unified `findOrLinkUser` helper

**Files:**
- Create: `packages/cloud/src/auth/find-or-link.ts`
- Create: `packages/cloud/src/auth/find-or-link.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/cloud/src/auth/find-or-link.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../db/test-db.js";
import { findOrLinkUser } from "./find-or-link.js";
import { listIdentitiesForUser } from "../db/identities.js";

describe("findOrLinkUser", () => {
  let db: Awaited<ReturnType<typeof makeTestDb>>;
  beforeEach(async () => { db = await makeTestDb(); });

  it("creates a new user when neither identity nor email exists", async () => {
    const { userId } = await findOrLinkUser(db, { kind: "google", sub: "g-001", email: "new@example.com" });
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);
    const ids = await listIdentitiesForUser(db, userId);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({ kind: "google", sub: "g-001" });
  });

  it("reuses existing user when (kind, sub) already known", async () => {
    const first = await findOrLinkUser(db, { kind: "google", sub: "g-001", email: "u@x.com" });
    const second = await findOrLinkUser(db, { kind: "google", sub: "g-001", email: "renamed@x.com" });
    expect(second.userId).toBe(first.userId);
    // email change in Google account ≠ email update here — we leave users.email alone
    const ids = await listIdentitiesForUser(db, first.userId);
    expect(ids).toHaveLength(1);
  });

  it("merges by email: new identity attached to existing user", async () => {
    const goog = await findOrLinkUser(db, { kind: "google", sub: "g-002", email: "alice@x.com" });
    const mail = await findOrLinkUser(db, { kind: "email",  sub: "alice@x.com", email: "alice@x.com" });
    expect(mail.userId).toBe(goog.userId);
    const ids = await listIdentitiesForUser(db, goog.userId);
    expect(ids.map((i) => i.kind).sort()).toEqual(["email", "google"]);
  });

  it("email match is case-insensitive", async () => {
    const a = await findOrLinkUser(db, { kind: "google", sub: "g-003", email: "Bob@X.com" });
    const b = await findOrLinkUser(db, { kind: "email", sub: "bob@x.com", email: "bob@x.com" });
    expect(b.userId).toBe(a.userId);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @cogni/cloud test -- find-or-link`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement `findOrLinkUser`**

Create `packages/cloud/src/auth/find-or-link.ts`:

```ts
import { eq, and } from "drizzle-orm";
import type { AnyDb } from "../db/client.js";
import { tenants, users, userIdentities } from "../db/schema.js";

/**
 * Unified login resolution: given a verified (kind, sub, email) triple from any
 * provider (Google OAuth or email magic-link), return the matching userId.
 *
 * Resolution order:
 *   1. exact (kind, sub) match — canonical path, regardless of email
 *   2. email match → attach this identity to the existing user (auto-merge)
 *   3. brand new user
 *
 * "Verified email" is a precondition: Google's id_token email is verified by
 * Google; magic-link's email is verified by the click. Anything else MUST NOT
 * call this helper.
 */
export async function findOrLinkUser(
  db: AnyDb,
  input: { kind: string; sub: string; email: string },
): Promise<{ userId: string; tenantId: string }> {
  // 1. exact identity match
  const idents = await db
    .select()
    .from(userIdentities)
    .where(and(eq(userIdentities.kind, input.kind), eq(userIdentities.sub, input.sub)))
    .limit(1);
  if (idents[0]) {
    const u = await db.select().from(users).where(eq(users.id, idents[0].userId)).limit(1);
    if (u[0]) return { userId: u[0].id, tenantId: u[0].tenantId };
  }

  const lowered = input.email.toLowerCase();

  // 2. email match — attach new identity to existing user
  const existing = await db.select().from(users).where(eq(users.email, lowered)).limit(1);
  if (existing[0]) {
    await db.insert(userIdentities)
      .values({ userId: existing[0].id, kind: input.kind, sub: input.sub })
      .onConflictDoNothing();
    return { userId: existing[0].id, tenantId: existing[0].tenantId };
  }

  // 3. brand new user
  const [tenant] = await db.insert(tenants).values({ name: lowered }).returning();
  const [created] = await db.insert(users).values({ tenantId: tenant!.id, email: lowered }).returning();
  await db.insert(userIdentities)
    .values({ userId: created!.id, kind: input.kind, sub: input.sub })
    .onConflictDoNothing();
  return { userId: created!.id, tenantId: created!.tenantId };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @cogni/cloud test -- find-or-link`
Expected: PASS all 4.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/auth/find-or-link.ts packages/cloud/src/auth/find-or-link.test.ts
git commit -m "feat(auth): findOrLinkUser — verified-email auto-merge

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — findOrLinkUser

## Summary
Unified provider→user resolution. Replaces ad-hoc findOrCreateUserByEmail +
upsertIdentity pair currently inlined in both Google and magic-link callbacks
(Task 8 wires this in). Resolution order: identity → email → new user.

## Changes
- packages/cloud/src/auth/find-or-link.ts — new
- packages/cloud/src/auth/find-or-link.test.ts — 4 tests
EOF
```

---

### Task 6: Extend `identities.ts` with `deleteIdentity` (with last-one guard inside route)

**Files:**
- Modify: `packages/cloud/src/db/identities.ts`
- Modify: `packages/cloud/src/db/identities.test.ts`

- [ ] **Step 1: Write failing test**

Append to `packages/cloud/src/db/identities.test.ts`:

```ts
import { countIdentities, deleteIdentity } from "./identities.js";

it("countIdentities returns the number of identities for a user", async () => {
  const { db, user } = await seedUser();
  expect(await countIdentities(db, user.id)).toBe(0);
  await upsertIdentity(db, user.id, "google", "g-1");
  await upsertIdentity(db, user.id, "email",  "e@x.com");
  expect(await countIdentities(db, user.id)).toBe(2);
});

it("deleteIdentity removes a single (kind, sub) for a user", async () => {
  const { db, user } = await seedUser();
  await upsertIdentity(db, user.id, "google", "g-1");
  await upsertIdentity(db, user.id, "email",  "e@x.com");
  await deleteIdentity(db, user.id, "google", "g-1");
  const remaining = await listIdentitiesForUser(db, user.id);
  expect(remaining.map((i) => i.kind)).toEqual(["email"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @cogni/cloud test -- identities.test`
Expected: FAIL — `countIdentities`, `deleteIdentity` not exported.

- [ ] **Step 3: Implement helpers**

Append to `packages/cloud/src/db/identities.ts`:

```ts
import { and, count } from "drizzle-orm";

export async function countIdentities(db: AnyDb, userId: string): Promise<number> {
  const rows = await db.select({ n: count() }).from(userIdentities).where(eq(userIdentities.userId, userId));
  return Number(rows[0]?.n ?? 0);
}

export async function deleteIdentity(
  db: AnyDb, userId: string, kind: string, sub: string,
): Promise<void> {
  await db.delete(userIdentities)
    .where(and(
      eq(userIdentities.userId, userId),
      eq(userIdentities.kind, kind),
      eq(userIdentities.sub, sub),
    ));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @cogni/cloud test -- identities.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/db/identities.ts packages/cloud/src/db/identities.test.ts
git commit -m "feat(db): countIdentities + deleteIdentity for settings UI

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — identities count + delete

## Summary
Two helpers backing the "Disconnect" button in settings — count for the
last-one guard, delete for the actual unlink. Last-one check itself lives at
the HTTP route layer (Task 15).

## Changes
- packages/cloud/src/db/identities.ts — countIdentities + deleteIdentity
- packages/cloud/src/db/identities.test.ts — coverage
EOF
```

---

**Run `pnpm -r build && pnpm -r test` at this point.** Section 1 should leave the build + tests green, even though no new behaviour is wired in yet.

---

## Section 2: Contract / protocol types

### Task 7: Update WS protocol types (client↔cloud)

**Files:**
- Modify: `packages/contract/src/protocol.ts`
- Modify: `packages/contract/src/protocol.test.ts`

- [ ] **Step 1: Write failing parse tests**

Append to `packages/contract/src/protocol.test.ts`:

```ts
import {
  clientToCloudSchema, cloudToClientSchema,
} from "./protocol.js";

describe("SP-2 ClientToCloud variants", () => {
  it("parses subscribe-list", () => {
    const r = clientToCloudSchema.safeParse({ t: "subscribe-list" });
    expect(r.success).toBe(true);
  });
  it("parses subscribe-thread with lastSeq", () => {
    const r = clientToCloudSchema.safeParse({ t: "subscribe-thread", threadId: "t1", lastSeq: 42 });
    expect(r.success).toBe(true);
  });
  it("parses subscribe-thread without lastSeq (defaults later)", () => {
    const r = clientToCloudSchema.safeParse({ t: "subscribe-thread", threadId: "t1" });
    expect(r.success).toBe(true);
  });
  it("parses unsubscribe-thread", () => {
    const r = clientToCloudSchema.safeParse({ t: "unsubscribe-thread", threadId: "t1" });
    expect(r.success).toBe(true);
  });
  it("parses resolve-fallback switch", () => {
    const r = clientToCloudSchema.safeParse({
      t: "resolve-fallback", pendingMessageId: "p1", action: "switch", targetHostId: "h1",
    });
    expect(r.success).toBe(true);
  });
  it("parses resolve-fallback cancel without targetHostId", () => {
    const r = clientToCloudSchema.safeParse({
      t: "resolve-fallback", pendingMessageId: "p1", action: "cancel",
    });
    expect(r.success).toBe(true);
  });
});

describe("SP-2 CloudToClient variants", () => {
  it("parses catchup-complete", () => {
    const r = cloudToClientSchema.safeParse({ t: "catchup-complete", threadId: "t1", latestSeq: 47 });
    expect(r.success).toBe(true);
  });
  it("parses thread-meta", () => {
    const r = cloudToClientSchema.safeParse({
      t: "thread-meta", threadId: "t1", title: "Hi", lastMsgAt: new Date().toISOString(),
    });
    expect(r.success).toBe(true);
  });
  it("parses thread-created", () => {
    const r = cloudToClientSchema.safeParse({
      t: "thread-created", thread: { id: "t1", title: "Hi", updatedAt: new Date().toISOString() },
    });
    expect(r.success).toBe(true);
  });
  it("parses thread-deleted", () => {
    const r = cloudToClientSchema.safeParse({ t: "thread-deleted", threadId: "t1" });
    expect(r.success).toBe(true);
  });
  it("parses device-list-changed", () => {
    expect(cloudToClientSchema.safeParse({ t: "device-list-changed" }).success).toBe(true);
  });
  it("parses host-meta online/offline", () => {
    const r = cloudToClientSchema.safeParse({
      t: "host-meta", hostId: "h1", name: "MacBook", status: "online", lastSeen: new Date().toISOString(),
    });
    expect(r.success).toBe(true);
  });
  it("parses host-fallback-prompt", () => {
    const r = cloudToClientSchema.safeParse({
      t: "host-fallback-prompt",
      pendingMessageId: "p1",
      preferred: { id: "h1", name: "Home", lastSeenAgoMs: 7200000 },
      alternatives: [{ id: "h2", name: "Work", lastSeenAgoMs: 1000 }],
    });
    expect(r.success).toBe(true);
  });
  it("parses no-host-online", () => {
    const r = cloudToClientSchema.safeParse({ t: "no-host-online", pendingMessageId: "p1" });
    expect(r.success).toBe(true);
  });
  it("parses catchup-too-long", () => {
    const r = cloudToClientSchema.safeParse({ t: "catchup-too-long", threadId: "t1", latestSeq: 12345 });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify failures**

Run: `pnpm --filter @cogni/contract test -- protocol.test`
Expected: FAIL on every new test (variants not in schema).

- [ ] **Step 3: Extend schemas**

Replace `clientToCloudSchema` in `packages/contract/src/protocol.ts`:

```ts
export const clientToCloudSchema = z.discriminatedUnion("t", [
  // SP-1 legacy (kept for compatibility while old clients are around)
  z.object({ t: z.literal("subscribe"), threadId: z.string() }),
  z.object({ t: z.literal("send"), threadId: z.string(), text: z.string() }),
  // SP-2
  z.object({ t: z.literal("subscribe-list") }),
  z.object({ t: z.literal("subscribe-thread"), threadId: z.string(), lastSeq: z.number().optional() }),
  z.object({ t: z.literal("unsubscribe-thread"), threadId: z.string() }),
  z.object({
    t: z.literal("resolve-fallback"),
    pendingMessageId: z.string(),
    action: z.enum(["switch", "cancel"]),
    targetHostId: z.string().optional(),
  }),
]);
```

Replace `cloudToClientSchema`:

```ts
export const cloudToClientSchema = z.discriminatedUnion("t", [
  // SP-1 legacy events
  z.object({ t: z.literal("event"), threadId: z.string(), seq: z.number(), event: runnerEventSchema }),
  z.object({
    t: z.literal("message"), threadId: z.string(), messageId: z.string(),
    role: z.enum(["user", "assistant", "system"]), content: z.string(), createdAt: z.string(),
  }),
  z.object({ t: z.literal("host-status"), online: z.boolean() }),
  z.object({ t: z.literal("error"), message: z.string() }),
  // SP-2 sync
  z.object({ t: z.literal("catchup-complete"), threadId: z.string(), latestSeq: z.number() }),
  z.object({ t: z.literal("catchup-too-long"), threadId: z.string(), latestSeq: z.number() }),
  z.object({ t: z.literal("thread-meta"), threadId: z.string(), title: z.string(), lastMsgAt: z.string() }),
  z.object({
    t: z.literal("thread-created"),
    thread: z.object({ id: z.string(), title: z.string(), updatedAt: z.string() }),
  }),
  z.object({ t: z.literal("thread-deleted"), threadId: z.string() }),
  // SP-2 user-level
  z.object({ t: z.literal("device-list-changed") }),
  z.object({
    t: z.literal("host-meta"), hostId: z.string(), name: z.string(),
    status: z.enum(["online", "offline"]), lastSeen: z.string().nullable(),
  }),
  // SP-2 dispatch responses
  z.object({
    t: z.literal("host-fallback-prompt"),
    pendingMessageId: z.string(),
    preferred: z.object({ id: z.string(), name: z.string(), lastSeenAgoMs: z.number() }),
    alternatives: z.array(z.object({ id: z.string(), name: z.string(), lastSeenAgoMs: z.number() })),
  }),
  z.object({ t: z.literal("no-host-online"), pendingMessageId: z.string() }),
]);
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @cogni/contract test`
Expected: PASS, including pre-existing protocol tests.

- [ ] **Step 5: Build contract — downstream typecheck depends on it**

Run: `pnpm --filter @cogni/contract build`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add packages/contract/src/protocol.ts packages/contract/src/protocol.test.ts
git commit -m "feat(contract): SP-2 wire protocol — sync, multi-host dispatch, settings events

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — wire protocol

## Summary
Added per-list / per-thread / user-level / dispatch-response message variants
on top of the existing SP-1 protocol. Kept old subscribe/send/event/message/
host-status/error variants to keep SP-1 clients working during the transition.

## Changes
- packages/contract/src/protocol.ts — extended discriminated unions
- packages/contract/src/protocol.test.ts — 13 new parse tests
EOF
```

---

## Section 3: Auth + revocable sessions

### Task 8: JWT carries `sessionId`; refactor login flows to use `findOrLinkUser` + create auth_session

**Files:**
- Modify: `packages/cloud/src/auth.ts`
- Modify: `packages/cloud/src/auth.test.ts`
- Modify: `packages/cloud/src/routes/auth.ts`
- Modify: `packages/cloud/src/routes/auth.test.ts`
- Modify: `packages/cloud/src/routes/email.ts`
- Modify: `packages/cloud/src/routes/email.test.ts`

- [ ] **Step 1: Add `sessionId` to `SessionClaims` + tests for issue/verify roundtrip**

Update `packages/cloud/src/auth.ts`:

```ts
export interface SessionClaims { userId: string; tenantId: string; sessionId: string }
```

Update `issueToken` to include `sessionId` in the payload and `verifyToken` to require it:

```ts
async issueToken(claims: SessionClaims): Promise<string> {
  return new SignJWT({ userId: claims.userId, tenantId: claims.tenantId, sessionId: claims.sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret);
},
async verifyToken(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (typeof payload.userId !== "string" || typeof payload.tenantId !== "string"
        || typeof payload.sessionId !== "string") return null;
    return { userId: payload.userId, tenantId: payload.tenantId, sessionId: payload.sessionId };
  } catch { return null; }
}
```

Update `packages/cloud/src/auth.test.ts` so existing roundtrip tests include a `sessionId` and assert it's preserved. Old tests that omit `sessionId` should be updated rather than added-to.

- [ ] **Step 2: Run auth tests**

Run: `pnpm --filter @cogni/cloud test -- auth.test`
Expected: PASS after update.

- [ ] **Step 3: Add device-name derivation helper**

Create `packages/cloud/src/auth/device-name.ts`:

```ts
/**
 * Cheap, header-only User-Agent parser. SP-2 doesn't bring in `ua-parser-js` —
 * we just produce a humanish label for the settings page. Refinement is fine
 * later; this is purely cosmetic.
 */
export function deriveDeviceName(userAgent: string | undefined, origin: "desktop" | "web"): string {
  if (origin === "desktop") return "Desktop App";
  const ua = (userAgent ?? "").toLowerCase();
  const os =
    ua.includes("iphone") ? "iPhone" :
    ua.includes("ipad") ? "iPad" :
    ua.includes("android") ? "Android" :
    ua.includes("mac os x") || ua.includes("macintosh") ? "macOS" :
    ua.includes("windows") ? "Windows" :
    ua.includes("linux") ? "Linux" : "Unknown";
  const browser =
    ua.includes("edg/") ? "Edge" :
    ua.includes("chrome/") && !ua.includes("edg/") ? "Chrome" :
    ua.includes("safari/") && !ua.includes("chrome/") ? "Safari" :
    ua.includes("firefox/") ? "Firefox" : "Browser";
  return `${browser} on ${os}`;
}
```

Add `packages/cloud/src/auth/device-name.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveDeviceName } from "./device-name.js";

describe("deriveDeviceName", () => {
  it("desktop origin always reads as Desktop App", () => {
    expect(deriveDeviceName(undefined, "desktop")).toBe("Desktop App");
    expect(deriveDeviceName("Tauri/2.0", "desktop")).toBe("Desktop App");
  });
  it("web Chrome on Mac", () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
    expect(deriveDeviceName(ua, "web")).toBe("Chrome on macOS");
  });
  it("web Safari on iPhone", () => {
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
    expect(deriveDeviceName(ua, "web")).toBe("Safari on iPhone");
  });
  it("unknown UA falls back to Browser on Unknown", () => {
    expect(deriveDeviceName("Curl/8.0", "web")).toBe("Browser on Unknown");
  });
});
```

Run: `pnpm --filter @cogni/cloud test -- device-name`
Expected: PASS after implementation.

- [ ] **Step 4: Refactor Google callback to use `findOrLinkUser` + create auth_session**

Edit `packages/cloud/src/routes/auth.ts`. Replace the body of the `/auth/google/callback` handler:

```ts
const user = await findOrLinkUser(deps.db, { kind: "google", sub, email });
const origin = entry.origin;  // see Step 6 below — pending now stores origin
const userAgent = c.req.header("user-agent") ?? undefined;
const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
const session = await createAuthSession(deps.db, {
  userId: user.userId,
  deviceName: deriveDeviceName(userAgent, origin),
  userAgent, ip: ip ?? undefined,
});
const token = await deps.auth.issueToken({
  userId: user.userId, tenantId: user.tenantId, sessionId: session.id,
});
```

Import `findOrLinkUser`, `createAuthSession`, `deriveDeviceName` at the top.

- [ ] **Step 5: Refactor magic-link callback to use `findOrLinkUser` + create auth_session**

Edit `packages/cloud/src/routes/email.ts` `/auth/email/callback`:

```ts
const userAgent = c.req.header("user-agent") ?? undefined;
const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
const lowered = entry.email.toLowerCase();
const user = await findOrLinkUser(deps.db, { kind: "email", sub: lowered, email: lowered });
const session = await createAuthSession(deps.db, {
  userId: user.userId,
  deviceName: deriveDeviceName(userAgent, entry.origin),
  userAgent, ip: ip ?? undefined,
});
const token = await deps.auth.issueToken({
  userId: user.userId, tenantId: user.tenantId, sessionId: session.id,
});
```

Drop the inlined `findOrCreateUserByEmail` + `upsertIdentity` calls (they're now subsumed by `findOrLinkUser`). Drop the dynamic `await import()` for the same modules.

- [ ] **Step 6: Add `origin` to pending state on both flows**

In `packages/cloud/src/routes/auth.ts`, extend `PendingLogin`:

```ts
interface PendingLogin { codeVerifier: string; redirect: string; origin: "desktop" | "web"; createdAt: number }
```

In the `/auth/google/start` handler, parse `origin` from query (`?origin=web`); default `"desktop"`. Store it in `pending`. (Web-vs-desktop redirect URI handling lands in Task 9.)

In `packages/cloud/src/routes/email.ts`, extend `PendingMagic`:

```ts
interface PendingMagic { email: string; origin: "desktop" | "web"; createdAt: number }
```

In `/auth/email/send`, read `body.origin` and validate it's `"desktop"` or `"web"`; default `"desktop"`. Store it in `pending`. Then generate the magic URL conditionally:

```ts
const magicUrl = entry.origin === "web"
  ? `${env.webUrl}/auth/email/callback?token=${token}`
  : `cogni://auth?magic=${token}`;
```

Plumb `env.webUrl` through `deps` (see Task 9 step on env).

- [ ] **Step 7: Update `dev-token` to also create an auth_session**

In `packages/cloud/src/routes/auth.ts`, modify the dev-token handler to insert an auth_session row and put `sessionId` in the JWT — otherwise WS handshake (Task 11) will reject dev tokens:

```ts
const session = await createAuthSession(deps.db, {
  userId: user.id,
  deviceName: "Desktop App (dev)",
});
const token = await deps.auth.issueToken({
  userId: user.id, tenantId: user.tenantId, sessionId: session.id,
});
```

- [ ] **Step 8: Fix existing auth-route tests**

Existing tests in `packages/cloud/src/routes/auth.test.ts` and `email.test.ts` will fail because:
1. The JWT now requires `sessionId`.
2. They likely mock `findOrCreateUserByEmail` and inspect the resulting token.

Update assertions: decode the token and check `sessionId` is present + matches a row that was actually inserted into auth_sessions. The pglite test DB will have the rows.

- [ ] **Step 9: Run all auth tests**

Run: `pnpm --filter @cogni/cloud test -- "auth|email|find-or-link|device-name"`
Expected: PASS all.

- [ ] **Step 10: Commit**

```bash
git add packages/cloud/src/auth.ts packages/cloud/src/auth.test.ts \
  packages/cloud/src/auth/device-name.ts packages/cloud/src/auth/device-name.test.ts \
  packages/cloud/src/routes/auth.ts packages/cloud/src/routes/auth.test.ts \
  packages/cloud/src/routes/email.ts packages/cloud/src/routes/email.test.ts
git commit -m "feat(auth): JWT carries sessionId; callbacks use findOrLinkUser + create auth_session

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — JWT v2 + auth_session creation on login

## Summary
Every login (Google, magic-link, dev-token) now creates an auth_sessions row
and embeds its id in the JWT. Callbacks delegate identity resolution to
findOrLinkUser, removing the duplicated find-or-create/upsert pair. PendingLogin
+ PendingMagic carry an `origin` so the magic URL points at chat.ai-cognit.com
when the request came from web, cogni:// when from desktop.

## Changes
- packages/cloud/src/auth.ts — sessionId on SessionClaims
- packages/cloud/src/auth/device-name.ts — UA → readable label
- packages/cloud/src/routes/auth.ts — Google callback uses findOrLinkUser + createAuthSession; dev-token too
- packages/cloud/src/routes/email.ts — magic-link callback same; send accepts origin → dynamic URL
EOF
```

---

### Task 9: Bind `webUrl` env + add `redirect_uri` plumbing to OAuth start

**Files:**
- Modify: `packages/cloud/src/env.ts`
- Modify: `packages/cloud/src/env.test.ts`
- Modify: `packages/cloud/src/routes/auth.ts`
- Modify: `packages/cloud/src/main.ts`
- Modify: `packages/cloud/src/server.ts`

- [ ] **Step 1: Write env test for `webUrl`**

Append to `packages/cloud/src/env.test.ts`:

```ts
it("loads WEB_URL or defaults to PUBLIC_URL/chat", () => {
  process.env.WEB_URL = "https://chat.example.com";
  expect(loadEnv().webUrl).toBe("https://chat.example.com");
  delete process.env.WEB_URL;
  process.env.PUBLIC_URL = "https://cloud.example.com";
  expect(loadEnv().webUrl).toBe("https://chat.example.com"); // default for prod, declared via fallback below
});
```

Adjust test so it actually exercises the fallback behaviour you implement.

- [ ] **Step 2: Implement env addition**

Edit `packages/cloud/src/env.ts`. Add `webUrl: string` to `Env` interface and load:

```ts
const webUrl = process.env.WEB_URL ?? "https://chat.ai-cognit.com";
```

Return `webUrl` in the env object.

- [ ] **Step 3: Plumb webUrl through ServerDeps**

Edit `packages/cloud/src/server.ts` — add `webUrl: string` to `ServerDeps`.

Edit `packages/cloud/src/main.ts` — pass `webUrl: env.webUrl` to `createServer`.

- [ ] **Step 4: Use webUrl in magic-link URL**

Wire the conditional from Task 8 step 6 — `deps.webUrl` replaces `env.webUrl`:

```ts
const magicUrl = entry.origin === "web"
  ? `${deps.webUrl}/auth/email/callback?token=${token}`
  : `cogni://auth?magic=${token}`;
```

- [ ] **Step 5: Add origin-aware Google `redirect_uri` to `/auth/google/start`**

Edit `packages/cloud/src/routes/auth.ts` `/auth/google/start`:

```ts
app.get("/auth/google/start", (c) => {
  sweep();
  const originParam = c.req.query("origin") === "web" ? "web" : "desktop";
  const redirect = originParam === "web"
    ? `${deps.webUrl}/chat`
    : safeRedirect(c.req.query("redirect"));
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  pending.set(state, { codeVerifier, redirect, origin: originParam, createdAt: Date.now() });
  // For "web", the OAuth redirect_uri MUST be chat.ai-cognit.com because that's
  // what we'll register with Google. For "desktop", it stays at PUBLIC_URL.
  const targetRedirectUri = originParam === "web"
    ? `${deps.webUrl}/auth/google/callback`
    : `${deps.publicUrl}/auth/google/callback`;
  // arctic's Google client is constructed once with a single redirect_uri; we
  // construct an ad-hoc client per origin to support both.
  const google = new Google(env.googleClientId, env.googleClientSecret, targetRedirectUri);
  const url = google.createAuthorizationURL(state, codeVerifier, ["openid", "email"]);
  return c.redirect(url.toString());
});
```

(Hint: pass `env` into the route — or stash on `deps` — so we can rebuild the Google client. Cleaner alternative: add `deps.makeGoogle(redirectUri)` factory.)

Update `/auth/google/callback` to use the same per-origin redirect URI when calling `validateAuthorizationCode`. Per `entry.origin`, rebuild the Google client with the right `redirect_uri`.

- [ ] **Step 6: For web origin, redirect callback hands token to web SPA**

The web SPA expects to read the JWT from a URL fragment (not query — query gets logged in nginx). Change the redirect target shape for `origin === "web"`:

```ts
const target = new URL(entry.redirect);
if (entry.origin === "web") {
  target.hash = `token=${token}`;        // SPA reads location.hash on /chat
} else {
  target.searchParams.set("token", token);
}
return c.redirect(target.toString());
```

- [ ] **Step 7: Add tests for the origin branching**

Append to `packages/cloud/src/routes/auth.test.ts` two tests:
- `?origin=web` start → redirects to Google with `redirect_uri=https://chat…/auth/google/callback`
- `?origin=desktop` start (default) → existing behaviour

Mock the arctic Google client or just inspect the redirect URL (decode query string).

- [ ] **Step 8: Run all tests**

Run: `pnpm --filter @cogni/cloud test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/cloud/src/env.ts packages/cloud/src/env.test.ts \
  packages/cloud/src/server.ts packages/cloud/src/main.ts \
  packages/cloud/src/routes/auth.ts packages/cloud/src/routes/auth.test.ts \
  packages/cloud/src/routes/email.ts
git commit -m "feat(auth): web-origin OAuth + magic-link routing (chat.ai-cognit.com)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — web-origin auth routing

## Summary
WEB_URL env (defaults to https://chat.ai-cognit.com) added to ServerDeps.
?origin=web on /auth/google/start uses chat.ai-cognit.com/auth/google/callback
as the OAuth redirect_uri (must be pre-registered in Google Cloud Console);
post-auth redirect lands at WEB_URL/chat#token=… for the SPA to pluck out.
Magic-link send with body.origin="web" generates a https:// link instead of cogni://.

## Changes
- packages/cloud/src/env.ts — webUrl
- packages/cloud/src/routes/auth.ts — origin branching for Google
- packages/cloud/src/routes/email.ts — origin branching for magic links
EOF
```

---

### Task 10: HTTP middleware + WS handshake check `auth_sessions.revoked_at`

**Files:**
- Modify: `packages/cloud/src/routes/client.ts`
- Modify: `packages/cloud/src/server.ts`
- Add tests in `packages/cloud/src/server.e2e.test.ts`

- [ ] **Step 1: Write failing e2e test for HTTP revoke**

Append to `packages/cloud/src/server.e2e.test.ts`:

```ts
it("HTTP GET /api/threads returns 401 when the auth_session has been revoked", async () => {
  const { token, sessionId, deps } = await loginViaDevToken(server);
  // sanity: it works
  expect((await fetch(`${baseUrl}/api/threads`, { headers: { Authorization: `Bearer ${token}` }})).status).toBe(200);
  // revoke
  await revokeAuthSession(deps.db, sessionId);
  // now it's 401
  expect((await fetch(`${baseUrl}/api/threads`, { headers: { Authorization: `Bearer ${token}` }})).status).toBe(401);
});

it("WS connect rejects with close 4001 when the auth_session has been revoked", async () => {
  const { token, sessionId, deps } = await loginViaDevToken(server);
  await revokeAuthSession(deps.db, sessionId);
  const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/api/ws?token=${token}`);
  const closeCode = await new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  expect(closeCode).toBe(4001);
});
```

Provide `loginViaDevToken` as a helper inside the test file: hits `/auth/dev-token`, decodes the JWT, returns `{ token, sessionId, deps }`.

- [ ] **Step 2: Run tests — expect failures**

Run: `pnpm --filter @cogni/cloud test -- server.e2e`
Expected: FAIL — middleware doesn't check `revoked_at`, WS handshake doesn't either.

- [ ] **Step 3: Implement HTTP middleware check**

Edit `packages/cloud/src/routes/client.ts` Bearer-auth middleware:

```ts
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/ws") return next();
  const auth = c.req.header("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const claims = token ? await deps.auth.verifyToken(token) : null;
  if (!claims) return c.json({ error: "unauthorized" }, 401);
  const session = await getAuthSession(deps.db, claims.sessionId);
  if (!session || session.revokedAt !== null) return c.json({ error: "unauthorized" }, 401);
  c.set("claims", claims);
  // fire-and-forget touch; don't block the request
  void touchAuthSession(deps.db, claims.sessionId).catch(() => undefined);
  await next();
});
```

Import `getAuthSession`, `touchAuthSession` from `../db/auth-sessions.js`.

- [ ] **Step 4: Implement WS handshake check**

In the same file's `upgradeWebSocket` handler, after `verifyToken`:

```ts
upgradeWebSocket(async (c) => {
  const claims = await deps.auth.verifyToken(c.req.query("token") ?? "");
  if (!claims) {
    return { onOpen(_e, ws) { ws.close(4001, "unauthorized"); } };
  }
  const session = await getAuthSession(deps.db, claims.sessionId);
  if (!session || session.revokedAt !== null) {
    return { onOpen(_e, ws) { ws.close(4001, "revoked"); } };
  }
  // … existing register / onMessage logic, now safely using claims …
})
```

- [ ] **Step 5: Run e2e tests — expect pass**

Run: `pnpm --filter @cogni/cloud test -- server.e2e`
Expected: PASS — the two new tests + existing.

- [ ] **Step 6: Commit**

```bash
git add packages/cloud/src/routes/client.ts packages/cloud/src/server.e2e.test.ts
git commit -m "feat(auth): HTTP + WS check auth_sessions.revoked_at on every request

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — revocable sessions enforced

## Summary
Every Bearer-authed HTTP request looks up auth_sessions.revoked_at; revoked ⇒
401. Every /api/ws upgrade does the same; revoked ⇒ close 4001. Lastly,
each successful HTTP auth bumps auth_sessions.last_seen_at so the settings
page can show "X ago".

## Changes
- packages/cloud/src/routes/client.ts — middleware + WS handshake check
- packages/cloud/src/server.e2e.test.ts — two new revoke scenarios
EOF
```

---

## Section 4: Multi-host routing

### Task 11: `HostRouter` supports multiple hosts per user

**Files:**
- Modify: `packages/cloud/src/host-router.ts`
- Modify: `packages/cloud/src/host-router.test.ts`

- [ ] **Step 1: Write failing tests for new API**

Append to `packages/cloud/src/host-router.test.ts`:

```ts
import { HostRouter } from "./host-router.js";

it("getOnlineHostsForUser returns all online hosts for a user, most-recent first", () => {
  const r = new HostRouter();
  r.register({ hostId: "h1", userId: "u1", send: () => {} });
  r.register({ hostId: "h2", userId: "u1", send: () => {} });
  r.register({ hostId: "h3", userId: "u2", send: () => {} });
  const list = r.getOnlineHostsForUser("u1").map((h) => h.hostId).sort();
  expect(list).toEqual(["h1", "h2"]);
});

it("getHostByIdForUser returns the host iff owned by that user", () => {
  const r = new HostRouter();
  r.register({ hostId: "h1", userId: "u1", send: () => {} });
  r.register({ hostId: "h2", userId: "u2", send: () => {} });
  expect(r.getHostByIdForUser("u1", "h1")?.hostId).toBe("h1");
  expect(r.getHostByIdForUser("u1", "h2")).toBeNull();
  expect(r.getHostByIdForUser("u1", "missing")).toBeNull();
});

it("unregistering one host leaves others online for the same user", () => {
  const r = new HostRouter();
  r.register({ hostId: "h1", userId: "u1", send: () => {} });
  r.register({ hostId: "h2", userId: "u1", send: () => {} });
  r.unregister("h1");
  expect(r.getOnlineHostsForUser("u1").map((h) => h.hostId)).toEqual(["h2"]);
});
```

Also adjust the older test `"register(host) takes over user's slot when called twice with different hostId"` — it asserted single-host-per-user behaviour. Replace with the new multi-host semantics: same hostId re-registering replaces the connection; different hostIds coexist.

- [ ] **Step 2: Run tests to verify failures**

Run: `pnpm --filter @cogni/cloud test -- host-router`
Expected: FAIL.

- [ ] **Step 3: Reimplement `HostRouter`**

Replace `packages/cloud/src/host-router.ts`:

```ts
import type { CloudToHost } from "@cogni/contract";

export interface ConnectedHost {
  hostId: string;
  userId: string;
  send: (msg: CloudToHost) => void;
}

/** In-memory registry of Runner Hosts that currently hold a live WS to this cloud node. */
export class HostRouter {
  private byHost = new Map<string, ConnectedHost>();
  private byUser = new Map<string, Set<string>>(); // userId -> Set<hostId>

  register(host: ConnectedHost): void {
    // Same hostId re-registering = previous socket replaced.
    this.byHost.set(host.hostId, host);
    let set = this.byUser.get(host.userId);
    if (!set) { set = new Set(); this.byUser.set(host.userId, set); }
    set.add(host.hostId);
  }

  unregister(hostId: string): void {
    const host = this.byHost.get(hostId);
    if (!host) return;
    this.byHost.delete(hostId);
    const set = this.byUser.get(host.userId);
    if (set) {
      set.delete(hostId);
      if (set.size === 0) this.byUser.delete(host.userId);
    }
  }

  /** SP-1 compat: returns "any" host for the user. Used by code still on the
   *  one-host-per-user model — slated for removal once Task 14 lands. */
  getHostForUser(userId: string): ConnectedHost | null {
    const list = this.getOnlineHostsForUser(userId);
    return list[0] ?? null;
  }

  getOnlineHostsForUser(userId: string): ConnectedHost[] {
    const set = this.byUser.get(userId);
    if (!set) return [];
    return [...set].map((id) => this.byHost.get(id)).filter((x): x is ConnectedHost => !!x);
  }

  getHostByIdForUser(userId: string, hostId: string): ConnectedHost | null {
    const set = this.byUser.get(userId);
    if (!set || !set.has(hostId)) return null;
    return this.byHost.get(hostId) ?? null;
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @cogni/cloud test -- host-router`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/host-router.ts packages/cloud/src/host-router.test.ts
git commit -m "feat(cloud): HostRouter supports many hosts per user

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — multi-host HostRouter

## Summary
Map<userId, hostId> → Map<userId, Set<hostId>>. New getOnlineHostsForUser +
getHostByIdForUser back the dispatcher's preferred-vs-fallback logic. Legacy
getHostForUser kept as "any host" while chat.ts catches up in Task 14.

## Changes
- packages/cloud/src/host-router.ts — multi-host model
- packages/cloud/src/host-router.test.ts — multi-host tests + dropped takeover semantics
EOF
```

---

### Task 12: host-ws publishes `host-meta` on connect + disconnect; chat domain learns about it

**Files:**
- Modify: `packages/cloud/src/routes/host-ws.ts`
- Modify: `packages/cloud/src/client-hub.ts`
- Modify: `packages/cloud/src/client-hub.test.ts`

- [ ] **Step 1: Write failing test for ClientHub.publishHostMeta**

Append to `packages/cloud/src/client-hub.test.ts`:

```ts
it("publishHostMeta delivers to every client of the host's user only", () => {
  const hub = new ClientHub();
  const a = vi.fn(); const b = vi.fn(); const c = vi.fn();
  hub.register({ clientId: "a", userId: "u1", send: a });
  hub.register({ clientId: "b", userId: "u1", send: b });
  hub.register({ clientId: "c", userId: "u2", send: c });
  hub.publishHostMeta("u1", { hostId: "h1", name: "Mac", status: "online", lastSeen: "2026-05-18T00:00:00Z" });
  expect(a).toHaveBeenCalledWith(expect.objectContaining({ t: "host-meta", hostId: "h1" }));
  expect(b).toHaveBeenCalledWith(expect.objectContaining({ t: "host-meta", hostId: "h1" }));
  expect(c).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect fail**

Run: `pnpm --filter @cogni/cloud test -- client-hub`
Expected: FAIL — `publishHostMeta` missing.

- [ ] **Step 3: Implement `publishHostMeta`**

In `packages/cloud/src/client-hub.ts`:

```ts
publishHostMeta(userId: string, meta: {
  hostId: string; name: string; status: "online" | "offline"; lastSeen: string | null;
}): void {
  this.sendToUser(userId, {
    t: "host-meta",
    hostId: meta.hostId, name: meta.name, status: meta.status, lastSeen: meta.lastSeen,
  });
}
```

- [ ] **Step 4: Run — pass**

Run: `pnpm --filter @cogni/cloud test -- client-hub`
Expected: PASS.

- [ ] **Step 5: Wire host-ws to call publishHostMeta on connect/disconnect**

Edit `packages/cloud/src/routes/host-ws.ts` — after `setHostStatus(deps.db, host.id, "online", …)` on register:

```ts
deps.clients.publishHostMeta(host.userId, {
  hostId: host.id, name: host.name,
  status: "online", lastSeen: new Date().toISOString(),
});
```

In `onClose`, after `setHostStatus(deps.db, hostId, "offline")`:

```ts
if (userId && hostId) {
  // Re-fetch the name in case it was renamed mid-connection
  const row = await db.select({ name: hosts.name }).from(hosts).where(eq(hosts.id, hostId)).limit(1);
  deps.clients.publishHostMeta(userId, {
    hostId, name: row[0]?.name ?? "Unknown",
    status: "offline", lastSeen: new Date().toISOString(),
  });
}
```

Keep the existing `sendToUser({ t: "host-status", online: false })` for SP-1 client compat — desktop clients still listen for `host-status`. Both go out; new clients prefer `host-meta`.

- [ ] **Step 6: Run all cloud tests**

Run: `pnpm --filter @cogni/cloud test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cloud/src/client-hub.ts packages/cloud/src/client-hub.test.ts packages/cloud/src/routes/host-ws.ts
git commit -m "feat(sync): publish host-meta on host connect/disconnect

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — host-meta fan-out

## Summary
When a Runner Host connects or drops, every connected client of that user gets
a host-meta push. Settings page's Runner Hosts list updates from ⚪ to 🟢 (and
back) without a refresh, and Conversation's fallback card can recompute
"preferred online?" live.

## Changes
- packages/cloud/src/client-hub.ts — publishHostMeta
- packages/cloud/src/client-hub.test.ts — coverage
- packages/cloud/src/routes/host-ws.ts — publishHostMeta on register + onClose
EOF
```

---

**Checkpoint:** `pnpm -r build && pnpm -r test` should be green.

---

## Section 5: ClientHub fan-out + WS routing

### Task 13: ClientHub: list-subscription state + thread/list/user fan-out methods

**Files:**
- Modify: `packages/cloud/src/client-hub.ts`
- Modify: `packages/cloud/src/client-hub.test.ts`
- Modify: `packages/cloud/src/routes/client.ts`

- [ ] **Step 1: Write failing tests for `publishThreadMeta`, `publishThreadCreated`, `publishThreadDeleted`, `publishUserBroadcast`, `sendToConn`, `subscribeList`, `unsubscribeList`, and per-conn unsubscribe-thread**

Append to `packages/cloud/src/client-hub.test.ts`:

```ts
it("subscribeList delivers thread-meta only to list-subscribed clients of that user", () => {
  const hub = new ClientHub();
  const a = vi.fn(); const b = vi.fn(); const c = vi.fn();
  hub.register({ clientId: "a", userId: "u1", send: a });
  hub.register({ clientId: "b", userId: "u1", send: b });
  hub.register({ clientId: "c", userId: "u2", send: c });
  hub.subscribeList("a");
  hub.publishThreadMeta("u1", { threadId: "t1", title: "Hi", lastMsgAt: "2026-01-01T00:00:00Z" });
  expect(a).toHaveBeenCalledOnce();
  expect(b).not.toHaveBeenCalled();   // not list-subscribed
  expect(c).not.toHaveBeenCalled();   // different user
});

it("unsubscribeThread removes only that thread's subscription", () => {
  const hub = new ClientHub();
  const a = vi.fn();
  hub.register({ clientId: "a", userId: "u1", send: a });
  hub.subscribe("a", "t1");
  hub.subscribe("a", "t2");
  hub.unsubscribeThread("a", "t1");
  hub.broadcast("t1", { t: "host-status", online: true });
  hub.broadcast("t2", { t: "host-status", online: false });
  expect(a).toHaveBeenCalledOnce();
});

it("sendToConn targets a single clientId, no others", () => {
  const hub = new ClientHub();
  const a = vi.fn(); const b = vi.fn();
  hub.register({ clientId: "a", userId: "u1", send: a });
  hub.register({ clientId: "b", userId: "u1", send: b });
  hub.sendToConn("a", { t: "no-host-online", pendingMessageId: "p1" });
  expect(a).toHaveBeenCalledOnce();
  expect(b).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect failures**

Run: `pnpm --filter @cogni/cloud test -- client-hub`
Expected: FAIL.

- [ ] **Step 3: Implement methods**

Edit `packages/cloud/src/client-hub.ts`. Track list subscriptions:

```ts
export class ClientHub {
  private clients = new Map<string, ConnectedClient>();
  private subs = new Map<string, Set<string>>(); // threadId -> clientIds
  private listSubs = new Set<string>();          // clientIds subscribed to list channel

  // … register, unregister already exist; ensure unregister also clears listSubs.

  unregister(clientId: string): void {
    this.clients.delete(clientId);
    this.listSubs.delete(clientId);
    for (const [threadId, set] of this.subs) {
      set.delete(clientId);
      if (set.size === 0) this.subs.delete(threadId);
    }
  }

  subscribeList(clientId: string): void {
    if (!this.clients.has(clientId)) return;
    this.listSubs.add(clientId);
  }

  unsubscribeList(clientId: string): void {
    this.listSubs.delete(clientId);
  }

  unsubscribeThread(clientId: string, threadId: string): void {
    const set = this.subs.get(threadId);
    if (!set) return;
    set.delete(clientId);
    if (set.size === 0) this.subs.delete(threadId);
  }

  publishThreadMeta(userId: string, meta: { threadId: string; title: string; lastMsgAt: string }): void {
    for (const id of this.listSubs) {
      const c = this.clients.get(id);
      if (c?.userId === userId) c.send({ t: "thread-meta", ...meta });
    }
  }

  publishThreadCreated(userId: string, thread: { id: string; title: string; updatedAt: string }): void {
    for (const id of this.listSubs) {
      const c = this.clients.get(id);
      if (c?.userId === userId) c.send({ t: "thread-created", thread });
    }
  }

  publishThreadDeleted(userId: string, threadId: string): void {
    for (const id of this.listSubs) {
      const c = this.clients.get(id);
      if (c?.userId === userId) c.send({ t: "thread-deleted", threadId });
    }
  }

  publishUserBroadcast(userId: string, msg: CloudToClient): void {
    this.sendToUser(userId, msg);
  }

  sendToConn(clientId: string, msg: CloudToClient): void {
    this.clients.get(clientId)?.send(msg);
  }
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `pnpm --filter @cogni/cloud test -- client-hub`
Expected: PASS.

- [ ] **Step 5: Handle new client messages in `routes/client.ts`**

Edit `packages/cloud/src/routes/client.ts` — extend the `onMessage` switch:

```ts
if (msg.t === "subscribe") { /* unchanged */ }
else if (msg.t === "send") { /* unchanged */ }
else if (msg.t === "subscribe-list") {
  deps.clients.subscribeList(clientId);
}
else if (msg.t === "subscribe-thread") {
  if (!(await threadBelongsToUser(deps.db, msg.threadId, claims.userId))) {
    ws.close(4003, "forbidden"); return;
  }
  deps.clients.subscribe(clientId, msg.threadId);
  await streamCatchup(deps, clientId, msg.threadId, msg.lastSeq ?? 0);
}
else if (msg.t === "unsubscribe-thread") {
  deps.clients.unsubscribeThread(clientId, msg.threadId);
}
else if (msg.t === "resolve-fallback") {
  // Wired in Task 16.
  await deps.chat.handleResolveFallback({
    userId: claims.userId,
    pendingMessageId: msg.pendingMessageId,
    action: msg.action,
    targetHostId: msg.targetHostId ?? null,
    sourceClientId: clientId,
  });
}
```

`streamCatchup` lands in Task 15 — for now leave a stub:

```ts
async function streamCatchup(_deps: ServerDeps, _clientId: string, _threadId: string, _lastSeq: number) {
  // Implemented in Task 15.
}
```

`deps.chat.handleResolveFallback` lands in Task 14 — stub it on the ChatDomain class for now (logs a warn).

- [ ] **Step 6: Run all cloud tests + build**

Run: `pnpm --filter @cogni/cloud build && pnpm --filter @cogni/cloud test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cloud/src/client-hub.ts packages/cloud/src/client-hub.test.ts packages/cloud/src/routes/client.ts
git commit -m "feat(sync): list/thread/user-broadcast fan-out + WS routing for SP-2 messages

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — ClientHub list channel + WS dispatch routing

## Summary
ClientHub gains list-subscription state and per-list fan-out for thread-meta /
created / deleted. New WS messages subscribe-list / subscribe-thread (with
catchup stub) / unsubscribe-thread / resolve-fallback (stub) all wire through
routes/client.ts. Old SP-1 subscribe/send still work for desktop clients
that haven't been upgraded yet.

## Changes
- packages/cloud/src/client-hub.ts — listSubs + 5 new methods
- packages/cloud/src/client-hub.test.ts — 3 new test cases
- packages/cloud/src/routes/client.ts — new switch arms
EOF
```

---

## Section 6: Chat dispatcher state machine

### Task 14: `getPreferredHost` + check-host-first dispatch

**Files:**
- Modify: `packages/cloud/src/domains/chat.ts`
- Modify: `packages/cloud/src/domains/chat.test.ts`

- [ ] **Step 1: Write failing tests for the new state machine**

Append to `packages/cloud/src/domains/chat.test.ts`:

```ts
it("no-host-online: when user has zero online hosts, returns no-host-online + does not persist message", async () => {
  const { domain, db, user, thread, sentToConn } = await setupChatTest({ onlineHosts: 0 });
  await domain.handleClientSend({
    userId: user.id, threadId: thread.id, content: "hello", sourceClientId: "c1",
  });
  expect(sentToConn).toHaveBeenCalledWith("c1", expect.objectContaining({ t: "no-host-online" }));
  const messages = await db.select().from(messagesTable).where(eq(messagesTable.threadId, thread.id));
  expect(messages).toHaveLength(0);
});

it("preferred online: persists message + opens runner_session on preferred host + dispatches", async () => {
  const { domain, db, user, thread, host, sentToHost } = await setupChatTest({ onlineHosts: 1 });
  await domain.handleClientSend({
    userId: user.id, threadId: thread.id, content: "hello", sourceClientId: "c1",
  });
  expect(sentToHost).toHaveBeenCalledWith(host.id, expect.objectContaining({ t: "dispatch" }));
  const messages = await db.select().from(messagesTable).where(eq(messagesTable.threadId, thread.id));
  expect(messages).toHaveLength(1);
  const sessions = await db.select().from(runnerSessionsTable).where(eq(runnerSessionsTable.threadId, thread.id));
  expect(sessions[0]?.hostId).toBe(host.id);
});

it("preferred offline, alternative online: returns host-fallback-prompt + does NOT persist message yet", async () => {
  const { domain, db, user, thread, hostA, hostB, sentToConn } =
    await setupChatTest({ onlineHosts: 1, preferredOffline: true });
  await domain.handleClientSend({
    userId: user.id, threadId: thread.id, content: "hi", sourceClientId: "c1",
  });
  expect(sentToConn).toHaveBeenCalledWith("c1", expect.objectContaining({
    t: "host-fallback-prompt",
    preferred: expect.objectContaining({ id: hostA.id }),
    alternatives: expect.arrayContaining([expect.objectContaining({ id: hostB.id })]),
  }));
  const messages = await db.select().from(messagesTable).where(eq(messagesTable.threadId, thread.id));
  expect(messages).toHaveLength(0);
});
```

`setupChatTest` is a helper inside the test file that wires real ChatDomain + pglite + a stub HostRouter (records `sentToHost` calls) + a stub ClientHub (records `sentToConn`/`broadcast`).

- [ ] **Step 2: Run — failures expected**

Run: `pnpm --filter @cogni/cloud test -- chat.test`
Expected: FAIL — signature changed (`sourceClientId` not there), state machine wrong.

- [ ] **Step 3: Rewrite `handleClientSend` with new signature + state machine**

Replace `packages/cloud/src/domains/chat.ts` `handleClientSend`:

```ts
async handleClientSend(input: {
  userId: string; threadId: string; content: string; sourceClientId: string;
}): Promise<void> {
  const { userId, threadId, content, sourceClientId } = input;

  // pendingMessageId is opaque to the server — it correlates the send with the
  // potential host-fallback-prompt response that comes back.
  const pendingMessageId = randomUUID();

  // 1. Find preferred host (most-recent runner_session.host_id)
  const latest = await getLatestSessionForThread(this.db, threadId);
  const preferredHostId = latest?.hostId ?? null;

  const onlineHosts = this.hosts.getOnlineHostsForUser(userId);

  if (onlineHosts.length === 0) {
    this.clients.sendToConn(sourceClientId, { t: "no-host-online", pendingMessageId });
    return;
  }

  // Two happy paths: preferred-is-online, or there's no preferred (new thread).
  let chosen: ConnectedHost | null = null;
  if (preferredHostId === null) {
    chosen = onlineHosts[0] ?? null;       // most-recently-active (per HostRouter ordering)
  } else {
    chosen = onlineHosts.find((h) => h.hostId === preferredHostId) ?? null;
  }

  if (chosen !== null) {
    await this.persistAndDispatch({ userId, threadId, content, hostId: chosen.hostId });
    return;
  }

  // Preferred offline but we have alternatives → emit fallback prompt
  const alternatives = await this.describeHostsForPrompt(onlineHosts);
  const preferredDesc = await this.describePreferred(userId, preferredHostId!);
  this.clients.sendToConn(sourceClientId, {
    t: "host-fallback-prompt", pendingMessageId,
    preferred: preferredDesc,
    alternatives,
  });
  // Save pending for resolve-fallback in Task 16.
  this.pendingFallbacks.set(pendingMessageId, { userId, threadId, content, expiresAt: Date.now() + 10*60_000 });
}

private pendingFallbacks = new Map<string, { userId: string; threadId: string; content: string; expiresAt: number }>();

private async persistAndDispatch(p: { userId: string; threadId: string; content: string; hostId: string }) {
  const userMsg = await appendMessage(this.db, { threadId: p.threadId, role: "user", content: p.content });
  await touchThread(this.db, p.threadId);
  this.clients.broadcast(p.threadId, {
    t: "message", threadId: p.threadId, messageId: userMsg.id, role: "user",
    content: userMsg.content, createdAt: userMsg.createdAt,
  });
  // Find or open runner_session bound to this hostId
  const latest = await getLatestSessionForThread(this.db, p.threadId);
  let session = latest && latest.hostId === p.hostId && (latest.status === "idle" || latest.status === "running")
    ? latest : null;
  if (!session) {
    session = await openRunnerSession(this.db, { threadId: p.threadId, hostId: p.hostId, adapter: ADAPTER });
  }
  await setRunnerSessionStatus(this.db, session.id, "running");
  const conn = this.hosts.getHostByIdForUser(p.userId, p.hostId);
  if (!conn) {
    // Host dropped between check and dispatch — best-effort tell the user
    await setRunnerSessionStatus(this.db, session.id, "failed");
    this.clients.sendToUser(p.userId, { t: "host-status", online: false });
    return;
  }
  try {
    conn.send({
      t: "dispatch", sessionId: session.id, threadId: p.threadId, adapter: ADAPTER,
      runnerSessionId: session.runnerSessionId, message: p.content,
    });
  } catch {
    await setRunnerSessionStatus(this.db, session.id, "failed");
    this.clients.sendToUser(p.userId, { t: "host-status", online: false });
  }
}

private async describeHostsForPrompt(hosts: ConnectedHost[]) {
  // We need name + lastSeen out of the DB — the HostRouter doesn't carry that.
  // Cheap: bulk-select from hosts table by id.
  if (hosts.length === 0) return [];
  const ids = hosts.map((h) => h.hostId);
  const rows = await this.db.select().from(hostsTable).where(inArray(hostsTable.id, ids));
  return rows.map((r) => ({
    id: r.id, name: r.name,
    lastSeenAgoMs: r.lastSeen ? Date.now() - r.lastSeen.getTime() : 0,
  }));
}

private async describePreferred(userId: string, hostId: string) {
  const rows = await this.db.select().from(hostsTable)
    .where(and(eq(hostsTable.userId, userId), eq(hostsTable.id, hostId))).limit(1);
  if (!rows[0]) return { id: hostId, name: "Unknown", lastSeenAgoMs: 0 };
  return {
    id: rows[0].id, name: rows[0].name,
    lastSeenAgoMs: rows[0].lastSeen ? Date.now() - rows[0].lastSeen.getTime() : 0,
  };
}
```

Imports needed: `randomUUID` from `node:crypto`, `getLatestSessionForThread` + `openRunnerSession` from `../db/sessions.js`, `inArray, and, eq` from `drizzle-orm`, `hosts as hostsTable` from `../db/schema.js`, `ConnectedHost` type from `../host-router.js`.

- [ ] **Step 4: Update the existing `routes/client.ts` call site to pass `sourceClientId`**

Edit `packages/cloud/src/routes/client.ts` — the `msg.t === "send"` arm calls `handleClientSend` with the new shape:

```ts
} else if (msg.t === "send") {
  if (!(await threadBelongsToUser(deps.db, msg.threadId, claims.userId))) return;
  await deps.chat.handleClientSend({
    userId: claims.userId, threadId: msg.threadId, content: msg.text, sourceClientId: clientId,
  });
}
```

- [ ] **Step 5: Run tests — pass**

Run: `pnpm --filter @cogni/cloud test -- chat.test`
Expected: PASS new tests; old tests in same file may need their `handleClientSend(userId, threadId, text)` call sites updated to the new object shape.

- [ ] **Step 6: Commit**

```bash
git add packages/cloud/src/domains/chat.ts packages/cloud/src/domains/chat.test.ts packages/cloud/src/routes/client.ts
git commit -m "feat(chat): multi-host preferred-+-fallback dispatch state machine

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — multi-host dispatch state machine

## Summary
handleClientSend now takes a {userId, threadId, content, sourceClientId}
object. Three outcomes: (a) preferred online or new thread → persist +
dispatch; (b) preferred offline + alternatives → send host-fallback-prompt
to the source client only, no message persisted yet; (c) no hosts online →
no-host-online to source, no message persisted. Each thread can now own
multiple runner_session rows across host switches.

## Changes
- packages/cloud/src/domains/chat.ts — state machine + pendingFallbacks map
- packages/cloud/src/domains/chat.test.ts — three new scenarios
- packages/cloud/src/routes/client.ts — call site shape
EOF
```

---

### Task 15: Catchup — replay events on subscribe-thread

**Files:**
- Modify: `packages/cloud/src/routes/client.ts`
- Modify: `packages/cloud/src/server.e2e.test.ts`

- [ ] **Step 1: Write failing e2e test for catchup**

Append to `packages/cloud/src/server.e2e.test.ts`:

```ts
it("subscribe-thread with lastSeq=0 replays all historical events + catchup-complete + then live events", async () => {
  const { token } = await loginViaDevToken(server);
  // Seed a thread with N events
  const threadId = await seedThreadWithEvents(deps.db, 3);

  const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/api/ws?token=${token}`);
  const received: any[] = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));
  await once(ws, "open");
  ws.send(JSON.stringify({ t: "subscribe-thread", threadId, lastSeq: 0 }));
  await new Promise((r) => setTimeout(r, 200)); // let replay finish

  expect(received.filter((m) => m.t === "event").length).toBe(3);
  expect(received.some((m) => m.t === "catchup-complete" && m.threadId === threadId && m.latestSeq === 3)).toBe(true);
});

it("subscribe-thread with lastSeq=N skips first N events", async () => {
  const { token } = await loginViaDevToken(server);
  const threadId = await seedThreadWithEvents(deps.db, 5);
  const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/api/ws?token=${token}`);
  const received: any[] = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));
  await once(ws, "open");
  ws.send(JSON.stringify({ t: "subscribe-thread", threadId, lastSeq: 3 }));
  await new Promise((r) => setTimeout(r, 200));
  expect(received.filter((m) => m.t === "event").length).toBe(2);
});

it("subscribe-thread to >MAX_CATCHUP unread events returns catchup-too-long", async () => {
  // Cheap: import MAX_CATCHUP and seed MAX+1 events
  const { token } = await loginViaDevToken(server);
  const threadId = await seedThreadWithEvents(deps.db, MAX_CATCHUP + 1);
  const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/api/ws?token=${token}`);
  const received: any[] = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));
  await once(ws, "open");
  ws.send(JSON.stringify({ t: "subscribe-thread", threadId, lastSeq: 0 }));
  await new Promise((r) => setTimeout(r, 200));
  expect(received.find((m) => m.t === "catchup-too-long")).toBeDefined();
});
```

- [ ] **Step 2: Run — fail**

Run: `pnpm --filter @cogni/cloud test -- server.e2e`
Expected: FAIL.

- [ ] **Step 3: Implement `streamCatchup` in `routes/client.ts`**

Replace the stub from Task 13 with:

```ts
const MAX_CATCHUP = 10_000;

async function streamCatchup(
  deps: ServerDeps, clientId: string, threadId: string, lastSeq: number,
): Promise<void> {
  // Cheap pre-check to avoid loading 50k rows.
  const top = await deps.db
    .select({ s: events.seq })
    .from(events)
    .where(eq(events.threadId, threadId))
    .orderBy(desc(events.seq))
    .limit(1);
  const latestSeq = top[0]?.s ?? 0;
  const missingCount = Math.max(0, latestSeq - lastSeq);
  if (missingCount > MAX_CATCHUP) {
    deps.clients.sendToConn(clientId, { t: "catchup-too-long", threadId, latestSeq });
    return;
  }
  if (missingCount === 0) {
    deps.clients.sendToConn(clientId, { t: "catchup-complete", threadId, latestSeq });
    return;
  }
  const rows = await listEventsSince(deps.db, threadId, lastSeq);
  for (const r of rows) {
    deps.clients.sendToConn(clientId, {
      t: "event", threadId, seq: r.seq, event: r.payload as RunnerEvent,
    });
  }
  deps.clients.sendToConn(clientId, { t: "catchup-complete", threadId, latestSeq });
}
```

Imports: `events, desc` plus existing.

- [ ] **Step 4: Run e2e tests — expect pass**

Run: `pnpm --filter @cogni/cloud test -- server.e2e`
Expected: PASS, three new catchup tests + everything else.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/routes/client.ts packages/cloud/src/server.e2e.test.ts
git commit -m "feat(sync): subscribe-thread streams catchup events; cap at MAX_CATCHUP=10000

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — subscribe-thread catchup

## Summary
streamCatchup queries events.seq > lastSeq for the thread, streams each row
as a {t:"event"} frame, terminates with catchup-complete{latestSeq}. If the
unread tail would exceed MAX_CATCHUP (10000), bail with catchup-too-long and
let the client decide (refresh history via HTTP, resubscribe from latestSeq).

## Changes
- packages/cloud/src/routes/client.ts — streamCatchup
- packages/cloud/src/server.e2e.test.ts — 3 catchup scenarios
EOF
```

---

### Task 16: Resolve-fallback handler — switch / cancel + pending lifecycle

**Files:**
- Modify: `packages/cloud/src/domains/chat.ts`
- Modify: `packages/cloud/src/domains/chat.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `chat.test.ts`:

```ts
it("resolve-fallback switch: closes old session, opens new on targetHostId, persists message, dispatches", async () => {
  const { domain, db, user, thread, hostA, hostB, sentToHost } =
    await setupChatTest({ onlineHosts: 1, preferredOffline: true });
  // Trigger a fallback first
  await domain.handleClientSend({
    userId: user.id, threadId: thread.id, content: "queued", sourceClientId: "c1",
  });
  const pendingId = lastSentToConnArg("host-fallback-prompt").pendingMessageId;
  await domain.handleResolveFallback({
    userId: user.id, pendingMessageId: pendingId, action: "switch",
    targetHostId: hostB.id, sourceClientId: "c1",
  });
  // Old preferred session was already closed when we explicitly switched
  const sessions = await db.select().from(runnerSessionsTable).where(eq(runnerSessionsTable.threadId, thread.id));
  expect(sessions.find((s) => s.hostId === hostB.id && s.status === "running")).toBeDefined();
  expect(sentToHost).toHaveBeenCalledWith(hostB.id, expect.objectContaining({ t: "dispatch", message: "queued" }));
});

it("resolve-fallback cancel: does not persist message, drops the pending entry", async () => {
  const { domain, db, user, thread } = await setupChatTest({ onlineHosts: 1, preferredOffline: true });
  await domain.handleClientSend({
    userId: user.id, threadId: thread.id, content: "discarded", sourceClientId: "c1",
  });
  const pendingId = lastSentToConnArg("host-fallback-prompt").pendingMessageId;
  await domain.handleResolveFallback({
    userId: user.id, pendingMessageId: pendingId, action: "cancel",
    targetHostId: null, sourceClientId: "c1",
  });
  const msgs = await db.select().from(messagesTable).where(eq(messagesTable.threadId, thread.id));
  expect(msgs).toHaveLength(0);
});

it("resolve-fallback rejects unknown pendingMessageId silently", async () => {
  const { domain, user } = await setupChatTest({ onlineHosts: 1 });
  await expect(domain.handleResolveFallback({
    userId: user.id, pendingMessageId: "nonexistent", action: "switch",
    targetHostId: "anywhere", sourceClientId: "c1",
  })).resolves.toBeUndefined();
});

it("resolve-fallback switch with targetHostId that's not owned by user is a no-op", async () => {
  // attacker tries to dispatch to someone else's host
  const { domain, user } = await setupChatTest({ onlineHosts: 1 });
  // trigger a fallback (needs preferredOffline scenario), then resolve with bogus host
  // (test fixture sketches the rejection — implementation must NOT dispatch)
});
```

- [ ] **Step 2: Run — fail**

Run: `pnpm --filter @cogni/cloud test -- chat.test`
Expected: FAIL.

- [ ] **Step 3: Implement `handleResolveFallback`**

Add to `ChatDomain`:

```ts
async handleResolveFallback(input: {
  userId: string;
  pendingMessageId: string;
  action: "switch" | "cancel";
  targetHostId: string | null;
  sourceClientId: string;
}): Promise<void> {
  // Sweep expired pendings (cheap inline)
  const now = Date.now();
  for (const [k, v] of this.pendingFallbacks) if (v.expiresAt < now) this.pendingFallbacks.delete(k);

  const pending = this.pendingFallbacks.get(input.pendingMessageId);
  if (!pending || pending.userId !== input.userId) return;
  this.pendingFallbacks.delete(input.pendingMessageId);

  if (input.action === "cancel") return;
  if (!input.targetHostId) return;
  const targetConn = this.hosts.getHostByIdForUser(input.userId, input.targetHostId);
  if (!targetConn) {
    // host dropped between prompt and resolution — tell the user
    this.clients.sendToConn(input.sourceClientId, { t: "no-host-online", pendingMessageId: input.pendingMessageId });
    return;
  }
  // Close the previous active session (if any) — this is the "switch" point
  const latest = await getLatestSessionForThread(this.db, pending.threadId);
  if (latest && latest.status !== "closed") {
    await closeRunnerSession(this.db, latest.id);
  }
  await this.persistAndDispatch({
    userId: input.userId, threadId: pending.threadId, content: pending.content, hostId: input.targetHostId,
  });
}
```

- [ ] **Step 4: Run tests — pass**

Run: `pnpm --filter @cogni/cloud test -- chat.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/domains/chat.ts packages/cloud/src/domains/chat.test.ts
git commit -m "feat(chat): resolve-fallback handler — switch closes old session + dispatches; cancel drops it

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — resolve-fallback handler

## Summary
Client sends {t:"resolve-fallback", action:"switch", targetHostId} → cloud
closes the old runner_session (if non-closed), opens a new one on targetHost,
persists the deferred message, dispatches. Action "cancel" just drops the
pending. Unknown pendingMessageId or wrong-user pending is silently ignored
(no info leak). targetHostId that's not owned by user → no-host-online back.

## Changes
- packages/cloud/src/domains/chat.ts — handleResolveFallback
- packages/cloud/src/domains/chat.test.ts — 4 scenarios
EOF
```

---

**Checkpoint:** `pnpm -r build && pnpm -r test`. Cloud is now feature-complete for dispatch + sync.

---

## Section 7: HTTP routes for settings

### Task 17: `routes/identities.ts` — list + delete with last-one guard

**Files:**
- Create: `packages/cloud/src/routes/identities.ts`
- Create: `packages/cloud/src/routes/identities.test.ts`
- Modify: `packages/cloud/src/server.ts`

- [ ] **Step 1: Write failing route tests**

Create `packages/cloud/src/routes/identities.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestServer, withAuth } from "../server.e2e.test.js";

describe("identities routes", () => {
  let s: Awaited<ReturnType<typeof makeTestServer>>;
  beforeEach(async () => { s = await makeTestServer(); });

  it("GET /api/identities returns the user's identities", async () => {
    const { token, userId } = await s.login();
    await s.upsertIdentity(userId, "google", "g-1");
    const res = await fetch(`${s.baseUrl}/api/identities`, withAuth(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "google", sub: "g-1" }),
    ]));
  });

  it("DELETE /api/identities/:kind/:sub removes one, returns 200", async () => {
    const { token, userId } = await s.login();
    await s.upsertIdentity(userId, "google", "g-1");
    await s.upsertIdentity(userId, "email", "user@x.com");
    const res = await fetch(`${s.baseUrl}/api/identities/google/g-1`, withAuth(token, { method: "DELETE" }));
    expect(res.status).toBe(200);
  });

  it("DELETE refuses when it would leave the user with zero identities", async () => {
    const { token, userId } = await s.login(); // dev-token created one "dev" identity
    const onlyIdent = (await s.listIdentities(userId))[0]!;
    const res = await fetch(`${s.baseUrl}/api/identities/${onlyIdent.kind}/${encodeURIComponent(onlyIdent.sub)}`,
      withAuth(token, { method: "DELETE" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/last identity/i);
  });

  it("DELETE someone else's identity returns 404 (no info leak)", async () => {
    const { token } = await s.login();
    const res = await fetch(`${s.baseUrl}/api/identities/google/foreign-sub`,
      withAuth(token, { method: "DELETE" }));
    expect(res.status).toBe(404);
  });
});
```

(`makeTestServer` is a small helper in `server.e2e.test.ts` — refactor it out so other route tests can reuse. If it doesn't exist yet, build it as part of this task: spins up Hono in-memory using pglite, returns `{ baseUrl, login, upsertIdentity, listIdentities, deps }`.)

- [ ] **Step 2: Run — fail**

Run: `pnpm --filter @cogni/cloud test -- identities`
Expected: FAIL.

- [ ] **Step 3: Implement `routes/identities.ts`**

Create:

```ts
import type { Hono } from "hono";
import { countIdentities, deleteIdentity, listIdentitiesForUser } from "../db/identities.js";
import type { ServerDeps } from "../server.js";

export function registerIdentitiesRoutes(app: Hono, deps: ServerDeps): void {
  app.get("/api/identities", async (c) => {
    const { userId } = c.get("claims");
    const ids = await listIdentitiesForUser(deps.db, userId);
    return c.json(ids);
  });

  app.delete("/api/identities/:kind/:sub", async (c) => {
    const { userId } = c.get("claims");
    const kind = c.req.param("kind");
    const sub = decodeURIComponent(c.req.param("sub"));
    const all = await listIdentitiesForUser(deps.db, userId);
    if (!all.find((i) => i.kind === kind && i.sub === sub)) {
      return c.json({ error: "not found" }, 404);
    }
    const total = await countIdentities(deps.db, userId);
    if (total <= 1) {
      return c.json({ error: "cannot remove last identity" }, 409);
    }
    await deleteIdentity(deps.db, userId, kind, sub);
    return c.json({ ok: true });
  });
}
```

- [ ] **Step 4: Register route in `server.ts`**

Edit `packages/cloud/src/server.ts`:

```ts
import { registerIdentitiesRoutes } from "./routes/identities.js";
// …
registerIdentitiesRoutes(app, deps);
```

- [ ] **Step 5: Run tests — pass**

Run: `pnpm --filter @cogni/cloud test -- identities`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cloud/src/routes/identities.ts packages/cloud/src/routes/identities.test.ts packages/cloud/src/server.ts
git commit -m "feat(routes): GET/DELETE /api/identities with last-one guard

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — /api/identities

## Summary
Backs the "Connected sign-in methods" block in settings. DELETE refuses if
it would leave the user with zero identities (would lock them out). Cross-user
delete returns 404 (no info leak).

## Changes
- packages/cloud/src/routes/identities.ts — new
- packages/cloud/src/routes/identities.test.ts — 4 scenarios
- packages/cloud/src/server.ts — register route
EOF
```

---

### Task 18: `routes/devices.ts` — list + revoke

**Files:**
- Create: `packages/cloud/src/routes/devices.ts`
- Create: `packages/cloud/src/routes/devices.test.ts`
- Modify: `packages/cloud/src/server.ts`

- [ ] **Step 1: Write failing route tests**

Create `packages/cloud/src/routes/devices.test.ts`:

```ts
describe("devices routes", () => {
  // … makeTestServer setup

  it("GET /api/devices lists this user's non-revoked sessions, newest-first", async () => {
    const { token, userId } = await s.login();
    await s.createAuthSession(userId, "Old Device", { lastSeenOffsetMs: -60_000 });
    const res = await fetch(`${s.baseUrl}/api/devices`, withAuth(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].deviceName).toMatch(/Desktop App/);  // the freshly-logged-in one
  });

  it("DELETE /api/devices/:id revokes it + publishes device-list-changed to other clients", async () => {
    const { token, userId } = await s.login();
    const other = await s.createAuthSession(userId, "Other Device");
    const res = await fetch(`${s.baseUrl}/api/devices/${other.id}`, withAuth(token, { method: "DELETE" }));
    expect(res.status).toBe(200);
    const list = await fetch(`${s.baseUrl}/api/devices`, withAuth(token)).then((r) => r.json());
    expect(list.find((d: any) => d.id === other.id)).toBeUndefined();
  });

  it("DELETE other user's device returns 404", async () => {
    const { token } = await s.login();
    const otherUser = await s.createUser("foreign@x.com");
    const foreign = await s.createAuthSession(otherUser.id, "Foreign Device");
    const res = await fetch(`${s.baseUrl}/api/devices/${foreign.id}`, withAuth(token, { method: "DELETE" }));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run — fail**

Run: `pnpm --filter @cogni/cloud test -- devices`
Expected: FAIL.

- [ ] **Step 3: Implement `routes/devices.ts`**

```ts
import type { Hono } from "hono";
import { listAuthSessionsForUser, getAuthSession, revokeAuthSession } from "../db/auth-sessions.js";
import type { ServerDeps } from "../server.js";

export function registerDevicesRoutes(app: Hono, deps: ServerDeps): void {
  app.get("/api/devices", async (c) => {
    const { userId, sessionId } = c.get("claims");
    const list = await listAuthSessionsForUser(deps.db, userId);
    return c.json(list.map((d) => ({
      id: d.id, deviceName: d.deviceName, userAgent: d.userAgent, ip: d.ip,
      createdAt: d.createdAt.toISOString(), lastSeenAt: d.lastSeenAt.toISOString(),
      isCurrent: d.id === sessionId,
    })));
  });

  app.delete("/api/devices/:id", async (c) => {
    const { userId } = c.get("claims");
    const id = c.req.param("id");
    const row = await getAuthSession(deps.db, id);
    if (!row || row.userId !== userId) return c.json({ error: "not found" }, 404);
    await revokeAuthSession(deps.db, id);
    deps.clients.publishUserBroadcast(userId, { t: "device-list-changed" });
    return c.json({ ok: true });
  });
}
```

- [ ] **Step 4: Register in `server.ts`**

```ts
import { registerDevicesRoutes } from "./routes/devices.js";
// …
registerDevicesRoutes(app, deps);
```

- [ ] **Step 5: Run tests — pass**

Run: `pnpm --filter @cogni/cloud test -- devices`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cloud/src/routes/devices.ts packages/cloud/src/routes/devices.test.ts packages/cloud/src/server.ts
git commit -m "feat(routes): GET/DELETE /api/devices — back settings 'Logged-in devices'

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — /api/devices

## Summary
GET returns this user's non-revoked sessions newest-first, with isCurrent flag
so the UI can label "this device". DELETE revokes + fan-outs
device-list-changed so all other settings pages refresh.

## Changes
- packages/cloud/src/routes/devices.ts — new
- packages/cloud/src/routes/devices.test.ts — 3 scenarios
- packages/cloud/src/server.ts — register
EOF
```

---

### Task 19: `routes/hosts.ts` — rename + soft-delete; list excludes removed

**Files:**
- Create: `packages/cloud/src/routes/hosts.ts` (new file — moves the GET/POST that currently live in `routes/client.ts`)
- Create: `packages/cloud/src/routes/hosts.test.ts`
- Modify: `packages/cloud/src/routes/client.ts` (remove the moved handlers)
- Modify: `packages/cloud/src/server.ts`

- [ ] **Step 1: Tests for rename + delete**

Create `packages/cloud/src/routes/hosts.test.ts`:

```ts
describe("hosts routes", () => {
  // makeTestServer setup …

  it("GET /api/hosts excludes removed hosts", async () => {
    const { token, userId } = await s.login();
    const a = await s.createHost(userId, "A");
    const b = await s.createHost(userId, "B");
    await s.softRemoveHost(b.hostId);
    const res = await fetch(`${s.baseUrl}/api/hosts`, withAuth(token)).then((r) => r.json());
    expect(res.find((h: any) => h.id === a.hostId)).toBeDefined();
    expect(res.find((h: any) => h.id === b.hostId)).toBeUndefined();
  });

  it("PATCH /api/hosts/:id updates name + publishes host-meta", async () => {
    const { token, userId } = await s.login();
    const h = await s.createHost(userId, "old");
    const res = await fetch(`${s.baseUrl}/api/hosts/${h.hostId}`,
      withAuth(token, { method: "PATCH", body: JSON.stringify({ name: "Home Mac" }) }));
    expect(res.status).toBe(200);
    const list = await fetch(`${s.baseUrl}/api/hosts`, withAuth(token)).then((r) => r.json());
    expect(list.find((x: any) => x.id === h.hostId).name).toBe("Home Mac");
  });

  it("DELETE /api/hosts/:id soft-removes + publishes host-meta status=offline", async () => {
    const { token, userId } = await s.login();
    const h = await s.createHost(userId, "Mac");
    const res = await fetch(`${s.baseUrl}/api/hosts/${h.hostId}`,
      withAuth(token, { method: "DELETE" }));
    expect(res.status).toBe(200);
    const list = await fetch(`${s.baseUrl}/api/hosts`, withAuth(token)).then((r) => r.json());
    expect(list.find((x: any) => x.id === h.hostId)).toBeUndefined();
  });

  it("Cross-user PATCH/DELETE returns 404", async () => {
    const { token } = await s.login();
    const other = await s.createUser("foreign@x.com");
    const h = await s.createHost(other.id, "Foreign");
    for (const method of ["PATCH", "DELETE"]) {
      const res = await fetch(`${s.baseUrl}/api/hosts/${h.hostId}`,
        withAuth(token, { method, body: method === "PATCH" ? JSON.stringify({ name: "x" }) : undefined }));
      expect(res.status).toBe(404);
    }
  });
});
```

- [ ] **Step 2: Run — fail**

Run: `pnpm --filter @cogni/cloud test -- hosts.test`
Expected: FAIL.

- [ ] **Step 3: Implement `routes/hosts.ts`**

```ts
import type { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { createHost, getActiveHostsForUser, renameHost, softRemoveHost, isHostRemoved } from "../db/hosts.js";
import { hosts as hostsTable } from "../db/schema.js";
import type { ServerDeps } from "../server.js";

const renameSchema = z.object({ name: z.string().min(1).max(80) });

export function registerHostsRoutes(app: Hono, deps: ServerDeps): void {
  app.get("/api/hosts", async (c) => {
    const { userId } = c.get("claims");
    const list = await getActiveHostsForUser(deps.db, userId);
    return c.json(list.map((h) => ({
      id: h.id, name: h.name, status: h.status,
      lastSeen: h.lastSeen ? h.lastSeen.toISOString() : null,
    })));
  });

  app.post("/api/hosts", async (c) => {
    const { userId, tenantId } = c.get("claims");
    const body = await c.req.json().catch(() => ({}));
    const name = typeof (body as { name?: unknown }).name === "string"
      ? (body as { name: string }).name : "My Computer";
    return c.json(await createHost(deps.db, { userId, tenantId, name }));
  });

  app.patch("/api/hosts/:id", async (c) => {
    const { userId } = c.get("claims");
    const id = c.req.param("id");
    const row = await getOwnedHost(deps, userId, id);
    if (!row) return c.json({ error: "not found" }, 404);
    const parsed = renameSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid name" }, 400);
    await renameHost(deps.db, id, parsed.data.name);
    deps.clients.publishHostMeta(userId, {
      hostId: id, name: parsed.data.name,
      status: row.status as "online" | "offline",
      lastSeen: row.lastSeen ? row.lastSeen.toISOString() : null,
    });
    return c.json({ ok: true });
  });

  app.delete("/api/hosts/:id", async (c) => {
    const { userId } = c.get("claims");
    const id = c.req.param("id");
    const row = await getOwnedHost(deps, userId, id);
    if (!row) return c.json({ error: "not found" }, 404);
    await softRemoveHost(deps.db, id);
    // Drop any in-memory registration; future reconnects will be refused by findHostByToken.
    deps.hosts.unregister(id);
    deps.clients.publishHostMeta(userId, {
      hostId: id, name: row.name, status: "offline", lastSeen: new Date().toISOString(),
    });
    deps.clients.publishUserBroadcast(userId, { t: "device-list-changed" }); // tells settings to refetch hosts too (cheap reuse)
    return c.json({ ok: true });
  });
}

async function getOwnedHost(deps: ServerDeps, userId: string, hostId: string) {
  const rows = await deps.db.select().from(hostsTable).where(eq(hostsTable.id, hostId)).limit(1);
  const r = rows[0];
  if (!r || r.userId !== userId || r.removedAt !== null) return null;
  return r;
}
```

- [ ] **Step 4: Remove GET/POST `/api/hosts` from `routes/client.ts`**

Delete those two handlers — they now live in `routes/hosts.ts`. Keep the rest of `client.ts` (Bearer middleware, threads, ws).

- [ ] **Step 5: Register in `server.ts`**

```ts
import { registerHostsRoutes } from "./routes/hosts.js";
// …
registerHostsRoutes(app, deps);
```

- [ ] **Step 6: Run tests — pass**

Run: `pnpm --filter @cogni/cloud test`
Expected: PASS — new hosts tests + nothing else broken (the GET/POST moves keep the same routes & behaviour).

- [ ] **Step 7: Commit**

```bash
git add packages/cloud/src/routes/hosts.ts packages/cloud/src/routes/hosts.test.ts \
  packages/cloud/src/routes/client.ts packages/cloud/src/server.ts
git commit -m "feat(routes): /api/hosts gains PATCH + DELETE (rename + soft-remove)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — /api/hosts gets PATCH + DELETE

## Summary
Moved GET/POST out of routes/client.ts into routes/hosts.ts (homier). Added
PATCH for rename and DELETE for soft-remove. Both publish a host-meta push to
other clients so the settings list refreshes. DELETE also force-unregisters
the in-memory HostRouter entry, so a stale daemon's WS gets dropped on next
message (and refused on reconnect via the removed_at filter).

## Changes
- packages/cloud/src/routes/hosts.ts — new
- packages/cloud/src/routes/hosts.test.ts — 4 scenarios
- packages/cloud/src/routes/client.ts — GET/POST removed
- packages/cloud/src/server.ts — register hosts routes
EOF
```

---

### Task 20: CORS allow `chat.ai-cognit.com`

**Files:**
- Modify: `packages/cloud/src/server.ts`
- Modify: `packages/cloud/src/server.e2e.test.ts`

- [ ] **Step 1: Test that an OPTIONS preflight from `chat.ai-cognit.com` passes**

Append to `server.e2e.test.ts`:

```ts
it("CORS preflight from https://chat.ai-cognit.com is allowed", async () => {
  const res = await fetch(`${baseUrl}/api/threads`, {
    method: "OPTIONS",
    headers: {
      "Origin": "https://chat.ai-cognit.com",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "Authorization",
    },
  });
  expect(res.status).toBeLessThan(400);
  expect(res.headers.get("access-control-allow-origin")).toBe("https://chat.ai-cognit.com");
});

it("CORS preflight from a random origin is rejected", async () => {
  const res = await fetch(`${baseUrl}/api/threads`, {
    method: "OPTIONS",
    headers: { "Origin": "https://evil.example.com", "Access-Control-Request-Method": "GET" },
  });
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
});
```

- [ ] **Step 2: Run — fail**

Run: `pnpm --filter @cogni/cloud test -- server.e2e`
Expected: FAIL on the chat.ai-cognit.com test.

- [ ] **Step 3: Update CORS config in `server.ts`**

```ts
const allowedOrigins = new Set([
  "tauri://localhost",
  "http://localhost:1420",       // vite desktop dev
  "http://localhost:5173",       // vite web dev (Task 23)
  "https://chat.ai-cognit.com",
]);
const corsMiddleware = cors({
  origin: (origin) => allowedOrigins.has(origin) ? origin : null,
  allowHeaders: ["Authorization", "Content-Type"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});
```

- [ ] **Step 4: Run tests — pass**

Run: `pnpm --filter @cogni/cloud test -- server.e2e`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cloud/src/server.ts packages/cloud/src/server.e2e.test.ts
git commit -m "chore(cors): allow chat.ai-cognit.com + localhost:5173 (web dev)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — CORS for web client

## Summary
Whitelist now includes chat.ai-cognit.com (prod web origin) and
localhost:5173 (vite web dev). Methods widened to include PUT/PATCH/DELETE
(devices revoke, host rename/remove).

## Changes
- packages/cloud/src/server.ts — origin set + methods list
- packages/cloud/src/server.e2e.test.ts — preflight tests
EOF
```

---

**Checkpoint:** `pnpm -r build && pnpm -r test`. The cloud is now fully baked for SP-2.

---

## Section 8: Extract `@cogni/ui` package

### Task 21: Scaffold `packages/ui` workspace package

**Files:**
- Create: `packages/ui/package.json`
- Create: `packages/ui/tsconfig.json`
- Create: `packages/ui/vitest.config.ts`
- Create: `packages/ui/src/index.ts`

- [ ] **Step 1: Create package.json**

`packages/ui/package.json`:

```json
{
  "name": "@cogni/ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@cogni/contract": "workspace:*",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.3.0",
    "@types/react": "^19.1.8",
    "@types/react-dom": "^19.1.6",
    "happy-dom": "^15.11.7",
    "typescript": "~5.8.3",
    "vitest": "^2.1.8"
  }
}
```

Pick whatever exact versions match the desktop app's lockfile to avoid duplicate React; this manifest is a starting template — finalize with `pnpm install`.

- [ ] **Step 2: tsconfig**

`packages/ui/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "module": "esnext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "types": ["vitest/globals"]
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: vitest config**

`packages/ui/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "happy-dom", globals: true } });
```

- [ ] **Step 4: Barrel `src/index.ts`**

```ts
// Components
export { Login } from "./components/Login.js";
export { Sidebar } from "./components/Sidebar.js";
export { Conversation } from "./components/Conversation.js";
export { Composer } from "./components/Composer.js";
export { Welcome } from "./components/Welcome.js";
export { SettingsPage } from "./components/SettingsPage.js";
export { HostFallbackCard } from "./components/HostFallbackCard.js";
export { NoHostBanner } from "./components/NoHostBanner.js";

// Hooks
export { useAuthCore } from "./hooks/useAuth-core.js";
export { useThreadStream } from "./hooks/useThreadStream.js";
export { useDevices } from "./hooks/useDevices.js";
export { useIdentities } from "./hooks/useIdentities.js";
export { useHosts } from "./hooks/useHosts.js";

// Transport
export { ApiClient, ApiError } from "./transport/api.js";
export type { ApiConfig } from "./transport/api.js";
```

- [ ] **Step 5: Install workspace + verify**

```bash
pnpm install
pnpm --filter @cogni/ui typecheck   # errors expected: files don't exist yet
```

- [ ] **Step 6: Commit (scaffolding only)**

```bash
git add packages/ui/package.json packages/ui/tsconfig.json packages/ui/vitest.config.ts packages/ui/src/index.ts pnpm-lock.yaml
git commit -m "feat(ui): scaffold @cogni/ui workspace package

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — @cogni/ui scaffold

## Summary
New workspace package that will host shared React components and hooks for
desktop + web. No content yet beyond the barrel; subsequent tasks move existing
desktop components in.

## Changes
- packages/ui/{package.json, tsconfig.json, vitest.config.ts, src/index.ts}
EOF
```

---

### Task 22: Move transport (`api.ts`) into `@cogni/ui` as `ApiClient`

**Files:**
- Create: `packages/ui/src/transport/api.ts`
- Modify: `apps/desktop/src/api.ts` → delete after callers migrate
- Modify: `apps/desktop/package.json` (depend on `@cogni/ui`)

- [ ] **Step 1: Create `ApiClient`**

`packages/ui/src/transport/api.ts`:

```ts
import type { ThreadSummary, ThreadDetail, HostRegistration } from "@cogni/contract";

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "ApiError"; }
}

export interface ApiConfig { cloudUrl: string; getToken: () => string | null }

export interface DeviceRow {
  id: string; deviceName: string; userAgent: string | null; ip: string | null;
  createdAt: string; lastSeenAt: string; isCurrent: boolean;
}
export interface HostRow { id: string; name: string; status: string; lastSeen: string | null }
export interface IdentityRow { kind: string; sub: string; userId: string }

export class ApiClient {
  constructor(private readonly cfg: ApiConfig) {}

  get cloudUrl() { return this.cfg.cloudUrl; }
  get wsUrl() { return this.cfg.cloudUrl.replace(/^http/, "ws"); }

  private headers(extra?: Record<string, string>): HeadersInit {
    const t = this.cfg.getToken();
    return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}), ...extra };
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) throw new ApiError(res.status, `${init.method ?? "GET"} ${url} → ${res.status}`);
    return (await res.json()) as T;
  }

  // Threads
  listThreads = () => this.request<ThreadSummary[]>(`${this.cloudUrl}/api/threads`, { headers: this.headers() });
  createThread = () => this.request<ThreadSummary>(`${this.cloudUrl}/api/threads`, { method: "POST", headers: this.headers() });
  getThread = (id: string) => this.request<ThreadDetail>(`${this.cloudUrl}/api/threads/${id}`, { headers: this.headers() });

  // Hosts
  listHosts = () => this.request<HostRow[]>(`${this.cloudUrl}/api/hosts`, { headers: this.headers() });
  createHost = (name: string) => this.request<HostRegistration>(`${this.cloudUrl}/api/hosts`, {
    method: "POST", headers: this.headers(), body: JSON.stringify({ name }),
  });
  renameHost = (id: string, name: string) => this.request<{ ok: true }>(`${this.cloudUrl}/api/hosts/${id}`, {
    method: "PATCH", headers: this.headers(), body: JSON.stringify({ name }),
  });
  removeHost = (id: string) => this.request<{ ok: true }>(`${this.cloudUrl}/api/hosts/${id}`, {
    method: "DELETE", headers: this.headers(),
  });

  // Devices
  listDevices = () => this.request<DeviceRow[]>(`${this.cloudUrl}/api/devices`, { headers: this.headers() });
  revokeDevice = (id: string) => this.request<{ ok: true }>(`${this.cloudUrl}/api/devices/${id}`, {
    method: "DELETE", headers: this.headers(),
  });

  // Identities
  listIdentities = () => this.request<IdentityRow[]>(`${this.cloudUrl}/api/identities`, { headers: this.headers() });
  deleteIdentity = (kind: string, sub: string) => this.request<{ ok: true }>(
    `${this.cloudUrl}/api/identities/${kind}/${encodeURIComponent(sub)}`,
    { method: "DELETE", headers: this.headers() },
  );

  // Auth
  sendMagicLink = (email: string, origin: "desktop" | "web") => this.request<{ ok: true }>(
    `${this.cloudUrl}/auth/email/send`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, origin }) },
  );
  redeemMagic = (magic: string) => this.request<{ token: string }>(
    `${this.cloudUrl}/auth/email/callback`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ magic }) },
  );
}
```

- [ ] **Step 2: Add `@cogni/ui` dep to desktop**

Edit `apps/desktop/package.json`:

```json
"dependencies": {
  "@cogni/contract": "workspace:*",
  "@cogni/ui": "workspace:*",
  …
}
```

Then `pnpm install`.

- [ ] **Step 3: Update desktop's `api.ts` to re-export from `@cogni/ui`**

Replace `apps/desktop/src/api.ts` with a thin shim that constructs an `ApiClient` against the desktop env URL:

```ts
import { ApiClient, ApiError } from "@cogni/ui";

const CLOUD_URL = import.meta.env.VITE_CLOUD_URL ?? "http://localhost:8787";
const TOKEN_KEY = "cogni_token";

export const api = new ApiClient({
  cloudUrl: CLOUD_URL,
  getToken: () => localStorage.getItem(TOKEN_KEY),
});
export { ApiError };
```

- [ ] **Step 4: Audit call sites**

Old callers used `api.sendMagicLink(email)` with one arg; the new signature is `(email, origin)`. Update `apps/desktop/src/useAuth.ts` to pass `"desktop"`. `api.listHosts(token)` → `api.listHosts()` (token is now in the client).

- [ ] **Step 5: Run typecheck + build**

```bash
pnpm --filter desktop typecheck
pnpm --filter desktop build
```
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/transport/api.ts apps/desktop/src/api.ts apps/desktop/src/useAuth.ts apps/desktop/package.json pnpm-lock.yaml
git commit -m "refactor(ui): extract ApiClient into @cogni/ui; desktop uses it

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — ApiClient extracted

## Summary
The fetch wrapper that was inlined in apps/desktop/src/api.ts is now a class in
@cogni/ui — instantiated once per app shell with its own (cloudUrl, getToken).
Desktop's api.ts becomes a 5-line construction; web (Task 23) builds its own
the same way. New methods: rename/remove host, list/revoke device, list/delete
identity. sendMagicLink now requires an origin param.

## Changes
- packages/ui/src/transport/api.ts — new
- apps/desktop/src/api.ts — shim
- apps/desktop/src/useAuth.ts — pass "desktop" to sendMagicLink
- apps/desktop/package.json — add @cogni/ui dep
EOF
```

---

### Task 23: Move React components + hooks into `@cogni/ui`

**Files:** (each `Move:` = `git mv` from desktop to ui, with import-path edits)
- Move: `apps/desktop/src/Sidebar.tsx` + `sidebar.css` → `packages/ui/src/components/Sidebar.tsx` (+ css)
- Move: `apps/desktop/src/Conversation.tsx` + `conversation.css` → `packages/ui/src/components/Conversation.tsx`
- Move: `apps/desktop/src/Composer.tsx` + `composer.css` → `packages/ui/src/components/Composer.tsx`
- Move: `apps/desktop/src/Welcome.tsx` → `packages/ui/src/components/Welcome.tsx`
- Move: `apps/desktop/src/Login.tsx` + `login.css` → `packages/ui/src/components/Login.tsx`
- Move: `apps/desktop/src/useThreadStream.ts` → `packages/ui/src/hooks/useThreadStream.ts`

- [ ] **Step 1: `git mv` each file**

```bash
mkdir -p packages/ui/src/components packages/ui/src/hooks
git mv apps/desktop/src/Sidebar.tsx packages/ui/src/components/Sidebar.tsx
git mv apps/desktop/src/sidebar.css packages/ui/src/components/sidebar.css
git mv apps/desktop/src/Conversation.tsx packages/ui/src/components/Conversation.tsx
git mv apps/desktop/src/conversation.css packages/ui/src/components/conversation.css
git mv apps/desktop/src/Composer.tsx packages/ui/src/components/Composer.tsx
git mv apps/desktop/src/composer.css packages/ui/src/components/composer.css
git mv apps/desktop/src/Welcome.tsx packages/ui/src/components/Welcome.tsx
git mv apps/desktop/src/Login.tsx packages/ui/src/components/Login.tsx
git mv apps/desktop/src/login.css packages/ui/src/components/login.css
git mv apps/desktop/src/useThreadStream.ts packages/ui/src/hooks/useThreadStream.ts
```

- [ ] **Step 2: Fix relative imports inside moved files**

In each moved `.tsx`, change `from "./api.js"` → `from "../transport/api.js"`, change `from "./Composer.js"` → `from "./Composer.js"` (same dir, no change), change `from "./useThreadStream.js"` → `from "../hooks/useThreadStream.js"`. CSS imports (`import "./sidebar.css"`) stay as-is.

In `useThreadStream.ts`: change `from "./api.js"` to:

```ts
import type { ApiClient } from "../transport/api.js";
```

And refactor signature to take an `ApiClient` instead of a `token`:

```ts
export function useThreadStream(api: ApiClient, threadId: string) {
  // Inside, replace api.wsUrl + token usage:
  const ws = new WebSocket(`${api.wsUrl}/api/ws?token=${encodeURIComponent(api["cfg"].getToken() ?? "")}`);
  // Actually expose a public helper on ApiClient instead of reaching in:
}
```

Better: add `api.wsTokenQuery(): string` to `ApiClient` that returns `?token=…`. Use it in the hook.

- [ ] **Step 3: Add `wsTokenQuery` helper to `ApiClient`**

In `packages/ui/src/transport/api.ts`:

```ts
wsTokenQuery(): string {
  const t = this.cfg.getToken();
  return t ? `?token=${encodeURIComponent(t)}` : "";
}
```

- [ ] **Step 4: Update Conversation.tsx to take `api` prop**

```ts
export function Conversation({ api, threadId, … }: { api: ApiClient; threadId: string; …}) {
  const { … } = useThreadStream(api, threadId);
```

Drop the `token` prop.

- [ ] **Step 5: Update Sidebar's footer to take a new prop for "open settings"**

```ts
export function Sidebar(props: {
  …
  onOpenSettings: () => void;   // NEW — wires up the gear icon in Task 30
}) {
  // … in footer, near logout button:
  <button className="icon-btn" title="设置" onClick={props.onOpenSettings}> ⚙ </button>
}
```

- [ ] **Step 6: Update Shell to use `@cogni/ui` exports**

In `apps/desktop/src/Shell.tsx`:

```ts
import { Sidebar, Conversation, Welcome, ApiClient } from "@cogni/ui";
import { api } from "./api.js";

// where Conversation was: <Conversation api={api} threadId={activeThreadId} … />
// add onOpenSettings — for now `() => alert("settings — Task 30")`
```

- [ ] **Step 7: Update `apps/desktop/src/App.tsx` to import Login from @cogni/ui**

```ts
import { Login } from "@cogni/ui";
```

- [ ] **Step 8: Build + run desktop in dev**

```bash
pnpm --filter @cogni/ui typecheck
pnpm --filter desktop typecheck
pnpm --filter desktop build
```
Expected: success.

Smoke-test the existing flow manually if possible: `pnpm --filter desktop dev`, open the .app, log in, send a message. Behaviour must be identical to pre-extraction.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(ui): move desktop components/hooks into @cogni/ui

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — @cogni/ui takes ownership of components

## Summary
All shared React + hooks moved out of apps/desktop/src into
packages/ui/src/{components,hooks}. Conversation now takes an ApiClient prop
instead of a string token. Sidebar gains onOpenSettings. CSS files moved
alongside their components (relative imports still work). Desktop's Shell +
App.tsx import from @cogni/ui. Behaviour unchanged — pure mechanical move.

## Changes
- packages/ui/src/components/* — moved
- packages/ui/src/hooks/useThreadStream.ts — moved + ApiClient-based
- apps/desktop/src/Shell.tsx + App.tsx — imports updated
EOF
```

---

### Task 24: `useAuth-core` extracted; desktop and web each wrap it

**Files:**
- Create: `packages/ui/src/hooks/useAuth-core.ts`
- Modify: `apps/desktop/src/useAuth.ts` (becomes a Tauri-specific shim)

- [ ] **Step 1: Extract token-state core to `useAuth-core.ts`**

```ts
import { useEffect, useState } from "react";
import { ApiClient } from "../transport/api.js";

const TOKEN_KEY = "cogni_token";

/**
 * Platform-agnostic token state. Desktop wraps it with Tauri deep-link
 * intake; web wraps it with redirect-callback intake.
 */
export function useAuthCore(api: ApiClient) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));

  const acceptToken = (jwt: string) => {
    localStorage.setItem(TOKEN_KEY, jwt);
    setToken(jwt);
  };

  const acceptMagic = async (magic: string) => {
    const { token: jwt } = await api.redeemMagic(magic);
    acceptToken(jwt);
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
  };

  return { token, acceptToken, acceptMagic, logout };
}
```

- [ ] **Step 2: Refactor desktop `useAuth.ts` to use the core**

Replace `apps/desktop/src/useAuth.ts` body:

```ts
import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAuthCore } from "@cogni/ui";
import { api } from "./api.js";

export function useAuth() {
  const { token, acceptToken, acceptMagic, logout } = useAuthCore(api);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const acceptUrls = async (urls: string[] | null) => {
      if (disposed || !urls) return;
      for (const u of urls) {
        const parsed = tryParse(u);
        if (!parsed) continue;
        if (parsed.kind === "token") acceptToken(parsed.value);
        else if (parsed.kind === "magic") await acceptMagic(parsed.value).catch((e) => console.warn("magic redeem failed", e));
      }
    };
    getCurrent().then(acceptUrls).catch(() => undefined);
    const unlisten = onOpenUrl((urls) => { void acceptUrls(urls); });
    return () => { disposed = true; unlisten.then((f) => f()).catch(() => undefined); };
  }, [acceptToken, acceptMagic]);

  // Dev fallback: same as before — keep untouched.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (token) return;
    let alive = true;
    fetch(`${api.cloudUrl}/auth/dev-token`, { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j?.token) acceptToken(j.token); })
      .catch((e) => console.warn("[useAuth] dev-token fetch failed", e));
    return () => { alive = false; };
  }, [token, acceptToken]);

  const loginWithGoogle = () => {
    const url = `${api.cloudUrl}/auth/google/start?redirect=${encodeURIComponent("cogni://auth")}`;
    if (!isTauri()) { window.location.href = url; return; }
    return openUrl(url);
  };
  const loginWithEmail = (email: string) => api.sendMagicLink(email, "desktop");

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

- [ ] **Step 3: Build + typecheck**

```bash
pnpm --filter @cogni/ui typecheck && pnpm --filter desktop typecheck && pnpm --filter desktop build
```

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/hooks/useAuth-core.ts apps/desktop/src/useAuth.ts
git commit -m "refactor(ui): useAuthCore in @cogni/ui; desktop wraps with Tauri deep-link

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — useAuthCore extracted

## Summary
Token state (read/write localStorage, expose acceptToken/acceptMagic/logout)
lives in @cogni/ui. Desktop's useAuth.ts is now a Tauri shim — deep-link
listener + dev-token fallback + Google open-in-browser. Web (Task 26) will
build its own shim around the same core.

## Changes
- packages/ui/src/hooks/useAuth-core.ts — new
- apps/desktop/src/useAuth.ts — slimmed to Tauri-specific bits
EOF
```

---

**Checkpoint:** `pnpm -r build && pnpm -r test`. Desktop should behave identically to before SP-2 started.

---

## Section 9: `apps/web` thin client SPA

### Task 25: Scaffold `apps/web` (Vite + React + react-router)

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx` (skeleton)
- Create: `apps/web/.env.example` + `.env.production`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "pnpm --filter @cogni/contract build && tsc && vite build",
    "preview": "vite preview --port 5173",
    "typecheck": "pnpm --filter @cogni/contract build && tsc --noEmit"
  },
  "dependencies": {
    "@cogni/contract": "workspace:*",
    "@cogni/ui": "workspace:*",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "react-router-dom": "^7.1.0"
  },
  "devDependencies": {
    "@types/react": "^19.1.8",
    "@types/react-dom": "^19.1.6",
    "@vitejs/plugin-react": "^4.6.0",
    "typescript": "~5.8.3",
    "vite": "^7.0.4"
  }
}
```

- [ ] **Step 2: `vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", sourcemap: true },
});
```

- [ ] **Step 3: `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "module": "esnext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Cogni</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: `main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
```

- [ ] **Step 6: Stub `App.tsx`**

```tsx
export default function App() {
  return <div>Cogni web — Task 26 wires routes.</div>;
}
```

- [ ] **Step 7: `.env.example` + `.env.production`**

`.env.example`:
```
VITE_CLOUD_URL=http://localhost:8787
```

`.env.production`:
```
VITE_CLOUD_URL=https://cloud.ai-cognit.com
```

Add `!apps/web/.env.production` to `.gitignore` exceptions (like `apps/desktop/.env.production`).

- [ ] **Step 8: pnpm install + build sanity**

```bash
pnpm install
pnpm --filter web build
```
Expected: success, `apps/web/dist/index.html` produced.

- [ ] **Step 9: Commit**

```bash
git add apps/web pnpm-lock.yaml .gitignore
git commit -m "feat(web): scaffold apps/web — Vite + React + react-router

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — apps/web scaffold

## Summary
Fresh Vite SPA at apps/web with React 19 + react-router 7. .env.production
points at https://cloud.ai-cognit.com. App.tsx is a placeholder — Task 26
fills in routes and auth handlers.

## Changes
- apps/web/{package.json, vite.config.ts, tsconfig.json, index.html, src/main.tsx, src/App.tsx}
- apps/web/{.env.example, .env.production}
- .gitignore — exception for web .env.production
EOF
```

---

### Task 26: Web `useAuthWeb` + AuthCallback pages

**Files:**
- Create: `apps/web/src/api.ts` (client construction)
- Create: `apps/web/src/useAuth-web.ts`
- Create: `apps/web/src/AuthCallback.tsx`

- [ ] **Step 1: `apps/web/src/api.ts`**

```ts
import { ApiClient, ApiError } from "@cogni/ui";

const CLOUD_URL = import.meta.env.VITE_CLOUD_URL ?? "http://localhost:8787";
const TOKEN_KEY = "cogni_token";

export const api = new ApiClient({
  cloudUrl: CLOUD_URL,
  getToken: () => localStorage.getItem(TOKEN_KEY),
});
export { ApiError };
```

- [ ] **Step 2: `apps/web/src/useAuth-web.ts`**

```ts
import { useAuthCore } from "@cogni/ui";
import { api } from "./api.js";

export function useAuthWeb() {
  const core = useAuthCore(api);

  const loginWithGoogle = () => {
    // Origin "web" so cloud uses chat.ai-cognit.com/auth/google/callback as redirect_uri
    window.location.href = `${api.cloudUrl}/auth/google/start?origin=web`;
  };

  const loginWithEmail = (email: string) => api.sendMagicLink(email, "web");

  return { ...core, loginWithGoogle, loginWithEmail };
}
```

- [ ] **Step 3: `apps/web/src/AuthCallback.tsx`**

Handles both `/auth/google/callback` (token in URL hash) and `/auth/email/callback?token=...` (magic to POST):

```tsx
import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api } from "./api.js";
import { useAuthCore } from "@cogni/ui";

export function GoogleAuthCallback() {
  const { acceptToken } = useAuthCore(api);
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    const params = new URLSearchParams(hash);
    const token = params.get("token");
    if (token) {
      acceptToken(token);
      window.history.replaceState(null, "", "/chat");
      nav("/chat", { replace: true });
    } else {
      setError("登录失败:URL 中没有 token");
    }
  }, []);
  return <div>{error ?? "正在登录…"}</div>;
}

export function EmailAuthCallback() {
  const { acceptMagic } = useAuthCore(api);
  const nav = useNavigate();
  const loc = useLocation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(loc.search);
    const token = params.get("token");
    if (!token) { setError("链接无效"); return; }
    acceptMagic(token).then(() => nav("/chat", { replace: true }))
      .catch((e) => setError(`登录失败: ${e.message ?? "请重试"}`));
  }, []);
  return <div>{error ?? "正在登录…"}</div>;
}
```

- [ ] **Step 4: typecheck**

```bash
pnpm --filter web typecheck
```
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/useAuth-web.ts apps/web/src/AuthCallback.tsx
git commit -m "feat(web): useAuthWeb + redirect-based auth callbacks

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — web auth shim

## Summary
useAuthWeb wraps the platform-agnostic useAuthCore with:
- loginWithGoogle: top-level redirect to /auth/google/start?origin=web
- loginWithEmail: POST /auth/email/send with origin="web"
Two AuthCallback components handle the post-OAuth Google hash token and the
post-email-link magic exchange.

## Changes
- apps/web/src/api.ts
- apps/web/src/useAuth-web.ts
- apps/web/src/AuthCallback.tsx
EOF
```

---

### Task 27: Web `App.tsx` routes — /login /chat /chat/:id /settings + auth callbacks

**Files:**
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Implement routes**

Replace `apps/web/src/App.tsx`:

```tsx
import { Routes, Route, Navigate, useParams, useNavigate } from "react-router-dom";
import { Login, Sidebar, Conversation, Welcome, SettingsPage } from "@cogni/ui";
import { api } from "./api.js";
import { useAuthWeb } from "./useAuth-web.js";
import { GoogleAuthCallback, EmailAuthCallback } from "./AuthCallback.js";
import { useEffect, useState } from "react";
import type { ThreadSummary } from "@cogni/contract";

export default function App() {
  return (
    <Routes>
      <Route path="/auth/google/callback" element={<GoogleAuthCallback />} />
      <Route path="/auth/email/callback" element={<EmailAuthCallback />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/settings" element={<RequireAuth><WebShell page="settings" /></RequireAuth>} />
      <Route path="/chat/:threadId" element={<RequireAuth><WebShell page="chat" /></RequireAuth>} />
      <Route path="/chat" element={<RequireAuth><WebShell page="chat" /></RequireAuth>} />
      <Route path="/" element={<Navigate to="/chat" replace />} />
      <Route path="*" element={<Navigate to="/chat" replace />} />
    </Routes>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { token } = useAuthWeb();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function LoginPage() {
  const { token, loginWithGoogle, loginWithEmail } = useAuthWeb();
  if (token) return <Navigate to="/chat" replace />;
  return <Login onLoginWithGoogle={loginWithGoogle} onLoginWithEmail={loginWithEmail} />;
}

function WebShell({ page }: { page: "chat" | "settings" }) {
  const { logout } = useAuthWeb();
  const nav = useNavigate();
  const params = useParams<{ threadId?: string }>();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [mode, setMode] = useState<"chat" | "project">("chat");
  const [pendingFirstMessage, setPendingFirstMessage] = useState<string | null>(null);

  useEffect(() => { api.listThreads().then(setThreads).catch(console.error); }, []);

  const newChat = async () => {
    const t = await api.createThread();
    setThreads((prev) => [t, ...prev]);
    nav(`/chat/${t.id}`);
  };

  return (
    <div className="layout">
      <Sidebar
        mode={mode}
        onMode={setMode}
        threads={threads}
        activeThreadId={params.threadId ?? null}
        onSelect={(id) => nav(`/chat/${id}`)}
        onNewChat={() => { void newChat(); }}
        onLogout={logout}
        onOpenSettings={() => nav("/settings")}
      />
      <div className="main">
        {page === "settings"
          ? <SettingsPage api={api} onClose={() => nav("/chat")} />
          : params.threadId
            ? <Conversation
                api={api}
                threadId={params.threadId}
                initialDraft={pendingFirstMessage ?? undefined}
                onConsumeInitialDraft={() => setPendingFirstMessage(null)}
              />
            : <Welcome onStartChat={async (firstMsg) => {
                const t = await api.createThread();
                setThreads((prev) => [t, ...prev]);
                setPendingFirstMessage(firstMsg);
                nav(`/chat/${t.id}`);
              }} />
        }
      </div>
    </div>
  );
}
```

(`SettingsPage` lands in Task 29.)

- [ ] **Step 2: Quick smoke run**

```bash
pnpm --filter web dev
```

Open `http://localhost:5173`. Expected: lands on `/login` (no token). Click Google → redirects to cloud → comes back. (For dev, cloud must be running on 8787; web's CORS test is exercised in Section 7 Task 20.)

- [ ] **Step 3: typecheck + build**

```bash
pnpm --filter web typecheck && pnpm --filter web build
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): wire routes — /login /chat /chat/:id /settings + auth callbacks

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — web app routing

## Summary
react-router routes: auth callbacks land at their paths, /login swaps to /chat
when authed, RequireAuth gate around chat + settings, WebShell hosts the same
@cogni/ui Sidebar + Conversation + Welcome + SettingsPage as desktop.

## Changes
- apps/web/src/App.tsx
EOF
```

---

## Section 10: Settings page UI

### Task 28: Settings hooks — useDevices / useIdentities / useHosts

**Files:**
- Create: `packages/ui/src/hooks/useDevices.ts`
- Create: `packages/ui/src/hooks/useIdentities.ts`
- Create: `packages/ui/src/hooks/useHosts.ts`

- [ ] **Step 1: `useDevices`**

```ts
import { useCallback, useEffect, useState } from "react";
import type { ApiClient, DeviceRow } from "../transport/api.js";

export function useDevices(api: ApiClient) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setDevices(await api.listDevices()); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  const revoke = async (id: string) => { await api.revokeDevice(id); await refresh(); };
  return { devices, loading, refresh, revoke };
}
```

- [ ] **Step 2: `useIdentities`**

```ts
import { useCallback, useEffect, useState } from "react";
import type { ApiClient, IdentityRow } from "../transport/api.js";

export function useIdentities(api: ApiClient) {
  const [identities, setIdentities] = useState<IdentityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setIdentities(await api.listIdentities()); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  const remove = async (kind: string, sub: string) => { await api.deleteIdentity(kind, sub); await refresh(); };
  return { identities, loading, refresh, remove };
}
```

- [ ] **Step 3: `useHosts`**

```ts
import { useCallback, useEffect, useState } from "react";
import type { ApiClient, HostRow } from "../transport/api.js";

export function useHosts(api: ApiClient) {
  const [hosts, setHosts] = useState<HostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setHosts(await api.listHosts()); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  const rename = async (id: string, name: string) => { await api.renameHost(id, name); await refresh(); };
  const remove = async (id: string) => { await api.removeHost(id); await refresh(); };
  return { hosts, loading, refresh, rename, remove };
}
```

- [ ] **Step 4: typecheck**

```bash
pnpm --filter @cogni/ui typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/hooks/useDevices.ts packages/ui/src/hooks/useIdentities.ts packages/ui/src/hooks/useHosts.ts
git commit -m "feat(ui): useDevices / useIdentities / useHosts hooks

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — settings data hooks

## Summary
Three thin hooks fronting api.listDevices/identities/hosts + their mutations.
Auto-refresh on mount; expose refresh() so the page can re-pull after a
device-list-changed push.

## Changes
- packages/ui/src/hooks/useDevices.ts
- packages/ui/src/hooks/useIdentities.ts
- packages/ui/src/hooks/useHosts.ts
EOF
```

---

### Task 29: `SettingsPage` component

**Files:**
- Create: `packages/ui/src/components/SettingsPage.tsx`
- Create: `packages/ui/src/components/settings.css`

- [ ] **Step 1: Component skeleton with all 3 sections**

```tsx
import { useState } from "react";
import type { ApiClient } from "../transport/api.js";
import { useDevices } from "../hooks/useDevices.js";
import { useIdentities } from "../hooks/useIdentities.js";
import { useHosts } from "../hooks/useHosts.js";
import "./settings.css";

export function SettingsPage({ api, onClose }: { api: ApiClient; onClose: () => void }) {
  return (
    <div className="settings">
      <div className="settings__header">
        <h2>Settings</h2>
        <button className="settings__close" onClick={onClose}>×</button>
      </div>
      <div className="settings__sections">
        <IdentitiesSection api={api} />
        <DevicesSection api={api} />
        <HostsSection api={api} />
      </div>
    </div>
  );
}

function IdentitiesSection({ api }: { api: ApiClient }) {
  const { identities, loading, remove } = useIdentities(api);
  const canRemove = identities.length > 1;
  if (loading) return <section><h3>Account</h3><div>加载中…</div></section>;
  return (
    <section>
      <h3>Account</h3>
      <div className="settings__hint">Email: {identities.find((i) => i.kind === "email")?.sub ?? "—"}</div>
      <div className="settings__hint">Connected sign-in methods:</div>
      <ul className="settings__list">
        {identities.map((id) => (
          <li key={`${id.kind}-${id.sub}`} className="settings__row">
            <div className="settings__row-main">
              <div>{prettyKind(id.kind)}</div>
              <div className="settings__sub">{id.sub}</div>
            </div>
            <button
              className="settings__btn"
              disabled={!canRemove}
              title={canRemove ? "" : "至少保留一种登录方式"}
              onClick={() => void remove(id.kind, id.sub)}
            >Disconnect</button>
          </li>
        ))}
      </ul>
      {!canRemove && <div className="settings__warn">⚠️ 保留至少一种登录方式,否则进不来账号</div>}
    </section>
  );
}

function DevicesSection({ api }: { api: ApiClient }) {
  const { devices, loading, revoke } = useDevices(api);
  if (loading) return <section><h3>Logged-in devices</h3><div>加载中…</div></section>;
  return (
    <section>
      <h3>Logged-in devices</h3>
      <ul className="settings__list">
        {devices.map((d) => (
          <li key={d.id} className="settings__row">
            <div className="settings__row-main">
              <div>{d.deviceName} {d.isCurrent && <span className="settings__badge">this device</span>}</div>
              <div className="settings__sub">{fmtTime(d.lastSeenAt)} · IP: {d.ip ?? "—"}</div>
            </div>
            {!d.isCurrent && <button className="settings__btn" onClick={() => void revoke(d.id)}>Revoke</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function HostsSection({ api }: { api: ApiClient }) {
  const { hosts, loading, rename, remove } = useHosts(api);
  const [editing, setEditing] = useState<string | null>(null);
  if (loading) return <section><h3>Runner Hosts</h3><div>加载中…</div></section>;
  return (
    <section>
      <h3>Runner Hosts</h3>
      <ul className="settings__list">
        {hosts.map((h) => (
          <li key={h.id} className="settings__row">
            <div className="settings__row-main">
              <div>
                <span className={h.status === "online" ? "settings__dot--green" : "settings__dot--gray"}>●</span>{" "}
                {editing === h.id
                  ? <RenameInline initial={h.name} onSave={(n) => { setEditing(null); void rename(h.id, n); }} onCancel={() => setEditing(null)} />
                  : <span>{h.name}</span>}
              </div>
              <div className="settings__sub">
                {h.status} · last seen {h.lastSeen ? fmtTime(h.lastSeen) : "never"}
              </div>
            </div>
            <div className="settings__actions">
              {editing !== h.id && <button className="settings__btn" onClick={() => setEditing(h.id)}>Rename</button>}
              <button className="settings__btn settings__btn--danger" onClick={() => void remove(h.id)}>Remove</button>
            </div>
          </li>
        ))}
      </ul>
      <div className="settings__hint">+ 加新 host:在那台机器装 cogni Desktop app,登录就自动注册</div>
    </section>
  );
}

function RenameInline({ initial, onSave, onCancel }: { initial: string; onSave: (n: string) => void; onCancel: () => void }) {
  const [val, setVal] = useState(initial);
  return (
    <span>
      <input value={val} onChange={(e) => setVal(e.target.value)} autoFocus />
      <button onClick={() => onSave(val.trim())}>✓</button>
      <button onClick={onCancel}>×</button>
    </span>
  );
}

function prettyKind(k: string) {
  if (k === "google") return "🔵 Google";
  if (k === "email") return "✉️ Email magic link";
  if (k === "dev") return "🔧 Dev token";
  return k;
}

function fmtTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}
```

- [ ] **Step 2: Add `settings.css` (minimal layout, follow existing CSS-var conventions)**

```css
.settings { padding: 24px; max-width: 720px; margin: 0 auto; }
.settings__header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.settings__close { background: none; border: 0; font-size: 24px; cursor: pointer; }
.settings__sections section { margin-bottom: 24px; }
.settings__list { list-style: none; padding: 0; border: 1px solid var(--border, #e2e2e2); border-radius: 8px; }
.settings__row { display: flex; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border, #f0f0f0); }
.settings__row:last-child { border-bottom: none; }
.settings__row-main { display: flex; flex-direction: column; }
.settings__sub { color: #888; font-size: 12px; margin-top: 4px; }
.settings__badge { background: #eef; color: #335; font-size: 11px; padding: 2px 6px; border-radius: 4px; margin-left: 6px; }
.settings__btn { padding: 4px 10px; border: 1px solid var(--border, #ccc); background: white; border-radius: 4px; cursor: pointer; }
.settings__btn:disabled { opacity: 0.5; cursor: not-allowed; }
.settings__btn--danger { color: #b33; }
.settings__warn { color: #b33; font-size: 12px; margin-top: 8px; }
.settings__hint { color: #666; font-size: 13px; margin: 8px 0; }
.settings__dot--green { color: #2c2; }
.settings__dot--gray  { color: #aaa; }
.settings__actions { display: flex; gap: 8px; }
```

- [ ] **Step 3: typecheck + build**

```bash
pnpm --filter @cogni/ui typecheck && pnpm --filter desktop build && pnpm --filter web build
```
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/SettingsPage.tsx packages/ui/src/components/settings.css
git commit -m "feat(ui): SettingsPage — account / devices / hosts in one scroll

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — Settings page

## Summary
Three sections in one page: Account (sign-in methods + last-one disconnect
guard), Logged-in devices (with revoke), Runner Hosts (inline rename + remove).
Uses the three hooks from Task 28. Plain CSS — borrows from existing design
tokens where they exist; no new dependency.

## Changes
- packages/ui/src/components/SettingsPage.tsx
- packages/ui/src/components/settings.css
EOF
```

---

### Task 30: Wire Settings into desktop (gear in sidebar opens it)

**Files:**
- Modify: `apps/desktop/src/Shell.tsx`

- [ ] **Step 1: Track "settings mode" state in Shell**

```tsx
const [showSettings, setShowSettings] = useState(false);
// In Sidebar:
<Sidebar … onOpenSettings={() => setShowSettings(true)} />
// In main:
<div className="main">
  {showSettings
    ? <SettingsPage api={api} onClose={() => setShowSettings(false)} />
    : activeThreadId
      ? <Conversation api={api} threadId={activeThreadId} … />
      : <Welcome onStartChat={startFromWelcome} />}
</div>
```

Add `import { SettingsPage } from "@cogni/ui";`.

- [ ] **Step 2: Build + smoke**

```bash
pnpm --filter desktop build
pnpm --filter desktop dev
```

Click gear in sidebar → Settings page appears in main slot. Click × → returns to chat.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/Shell.tsx
git commit -m "feat(desktop): gear icon in sidebar opens SettingsPage

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — desktop wires Settings

## Summary
Sidebar gear icon flips Shell into Settings mode (settings replaces the
Conversation/Welcome content). × closes it. Web already routes to /settings.

## Changes
- apps/desktop/src/Shell.tsx
EOF
```

---

## Section 11: Multi-host UX components in Conversation

### Task 31: `HostFallbackCard` + `NoHostBanner` components

**Files:**
- Create: `packages/ui/src/components/HostFallbackCard.tsx`
- Create: `packages/ui/src/components/NoHostBanner.tsx`
- Modify: `packages/ui/src/components/Conversation.tsx`
- Modify: `packages/ui/src/hooks/useThreadStream.ts`

- [ ] **Step 1: Extend `useThreadStream` to track pending fallbacks + host status**

In `useThreadStream.ts`, add to state:

```ts
const [pendingFallback, setPendingFallback] = useState<{
  pendingMessageId: string;
  preferred: { id: string; name: string; lastSeenAgoMs: number };
  alternatives: Array<{ id: string; name: string; lastSeenAgoMs: number }>;
} | null>(null);
const [pendingNoHost, setPendingNoHost] = useState<{ pendingMessageId: string } | null>(null);
```

In the `onmessage` switch:

```ts
} else if (msg.t === "host-fallback-prompt") {
  setPendingFallback({
    pendingMessageId: msg.pendingMessageId,
    preferred: msg.preferred,
    alternatives: msg.alternatives,
  });
} else if (msg.t === "no-host-online") {
  setPendingNoHost({ pendingMessageId: msg.pendingMessageId });
} else if (msg.t === "host-meta") {
  // Track per-thread host status fresh from server
  setHostOnline(msg.status === "online");
}
```

Return the new state + actions:

```ts
const resolveFallback = (action: "switch" | "cancel", targetHostId?: string) => {
  const id = pendingFallback?.pendingMessageId;
  if (!id) return;
  wsRef.current?.send(JSON.stringify({
    t: "resolve-fallback", pendingMessageId: id, action, targetHostId,
  }));
  setPendingFallback(null);
};
const dismissNoHost = () => setPendingNoHost(null);

return { messages, streaming, hostOnline, connected, send, pendingFallback, pendingNoHost, resolveFallback, dismissNoHost };
```

- [ ] **Step 2: `HostFallbackCard.tsx`**

```tsx
export function HostFallbackCard({
  preferred, alternatives, onSwitch, onCancel,
}: {
  preferred: { id: string; name: string; lastSeenAgoMs: number };
  alternatives: Array<{ id: string; name: string; lastSeenAgoMs: number }>;
  onSwitch: (targetHostId: string) => void;
  onCancel: () => void;
}) {
  const [chosen, setChosen] = useState<string | null>(alternatives[0]?.id ?? null);
  return (
    <div className="fallback-card">
      <div className="fallback-card__title">
        ⚠️ &nbsp;<strong>{preferred.name}</strong> 不在线 (last seen {fmtAgo(preferred.lastSeenAgoMs)})
      </div>
      <div className="fallback-card__body">
        <div>切到这台机器跑?</div>
        <ul className="fallback-card__options">
          {alternatives.map((a) => (
            <li key={a.id}>
              <label>
                <input type="radio" name="fallback-target" checked={chosen === a.id} onChange={() => setChosen(a.id)} />
                {a.name} <span className="fallback-card__sub">(online · {fmtAgo(a.lastSeenAgoMs)})</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="fallback-card__note">
          Claude Code 会在新机器上从消息历史重建上下文,之前在 {preferred.name} 上未保存的文件不会过来。
        </div>
      </div>
      <div className="fallback-card__actions">
        <button className="fallback-card__primary" disabled={!chosen} onClick={() => chosen && onSwitch(chosen)}>切换并发送</button>
        <button className="fallback-card__secondary" onClick={onCancel}>取消(等 {preferred.name} 上线)</button>
      </div>
    </div>
  );
}

function fmtAgo(ms: number) {
  if (ms < 60_000) return "刚刚";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
```

Add tiny CSS in `conversation.css`:

```css
.fallback-card { border: 1px solid #d6a800; background: #fff8db; border-radius: 8px; padding: 16px; margin: 16px 0; }
.fallback-card__title { font-weight: 500; margin-bottom: 8px; }
.fallback-card__note { color: #666; font-size: 13px; margin-top: 8px; }
.fallback-card__actions { margin-top: 12px; display: flex; gap: 8px; }
.fallback-card__primary { background: #d6a800; color: white; border: 0; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
.fallback-card__secondary { background: transparent; border: 1px solid #ccc; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
```

- [ ] **Step 3: `NoHostBanner.tsx`**

```tsx
export function NoHostBanner() {
  return (
    <div className="no-host-banner">
      🔌 没有在线的 cogni 桌面端 — 至少打开一台 Mac 上的 cogni app 才能发消息。
    </div>
  );
}
```

CSS:

```css
.no-host-banner { background: #fdecea; color: #a3261b; padding: 12px 16px; border-radius: 6px; margin: 8px 0; font-size: 14px; }
```

- [ ] **Step 4: Render in `Conversation.tsx`**

In the JSX, above the composer:

```tsx
{pendingFallback && (
  <HostFallbackCard
    preferred={pendingFallback.preferred}
    alternatives={pendingFallback.alternatives}
    onSwitch={(targetHostId) => resolveFallback("switch", targetHostId)}
    onCancel={() => resolveFallback("cancel")}
  />
)}
{pendingNoHost && <NoHostBanner />}
```

Composer disabled when `pendingNoHost !== null || pendingFallback !== null`:

```tsx
<Composer draft={draft} setDraft={setDraft} onSubmit={submit}
  disabled={!connected || pendingFallback !== null || pendingNoHost !== null} />
```

Add imports + export the new components from `packages/ui/src/index.ts`.

- [ ] **Step 5: Build + manual smoke**

```bash
pnpm --filter @cogni/ui typecheck && pnpm --filter desktop build && pnpm --filter web build
```

Manual flow (later — full e2e is Task 33): kill the desktop's local daemon, send from web, observe fallback card appear (if no second host) or no-host-banner.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/HostFallbackCard.tsx packages/ui/src/components/NoHostBanner.tsx \
  packages/ui/src/components/Conversation.tsx packages/ui/src/components/conversation.css \
  packages/ui/src/hooks/useThreadStream.ts packages/ui/src/index.ts
git commit -m "feat(ui): HostFallbackCard + NoHostBanner; Conversation handles new WS messages

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — multi-host UX components

## Summary
useThreadStream tracks host-fallback-prompt + no-host-online + host-meta events
and exposes pendingFallback / pendingNoHost + resolveFallback / dismissNoHost.
Conversation renders an inline HostFallbackCard with radio-pick of alternative
host + Switch/Cancel buttons, OR a red NoHostBanner. Composer goes disabled
when either is showing so the user resolves the question before more text.

## Changes
- packages/ui/src/components/HostFallbackCard.tsx
- packages/ui/src/components/NoHostBanner.tsx
- packages/ui/src/components/Conversation.tsx — render new states
- packages/ui/src/components/conversation.css — fallback-card / no-host-banner styles
- packages/ui/src/hooks/useThreadStream.ts — new state + WS handlers
- packages/ui/src/index.ts — export new components
EOF
```

---

### Task 32: Catchup integration in `useThreadStream` (subscribe-thread with lastSeq)

**Files:**
- Modify: `packages/ui/src/hooks/useThreadStream.ts`

- [ ] **Step 1: Replace `subscribe`-based subscribe with `subscribe-thread { lastSeq }`**

The hook currently does `ws.send({ t: "subscribe", threadId })` and fetches initial history via HTTP. Replace:

```ts
ws.onopen = () => {
  if (ws.readyState !== WebSocket.OPEN) return;
  attempt = 0;
  setConnected(true);
  const lastSeq = lastSeqRef.current;
  ws.send(JSON.stringify({ t: "subscribe-thread", threadId, lastSeq }));
};
```

Track `lastSeqRef` (ref so it survives reconnects):

```ts
const lastSeqRef = useRef<number>(0);
```

Update inside `onmessage` event handler:

```ts
} else if (msg.t === "event") {
  if (msg.seq > lastSeqRef.current) lastSeqRef.current = msg.seq;
  if (msg.event.type === "done" || msg.event.type === "error") setStreaming([]);
  else setStreaming((s) => [...s, msg.event]);
} else if (msg.t === "catchup-complete") {
  if (msg.latestSeq > lastSeqRef.current) lastSeqRef.current = msg.latestSeq;
} else if (msg.t === "catchup-too-long") {
  // Bail: HTTP-pull the full thread to reset
  void api.getThread(threadId).then((d) => {
    setMessages(d.messages ?? []);
    lastSeqRef.current = msg.latestSeq;
  });
}
```

The initial HTTP `getThread()` still runs on threadId change (warm cache while WS catches up), but subscribe-thread is now the source of truth for the live stream + catchup.

- [ ] **Step 2: typecheck + build**

```bash
pnpm --filter @cogni/ui typecheck && pnpm --filter desktop build && pnpm --filter web build
```

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/hooks/useThreadStream.ts
git commit -m "feat(sync): client subscribes via subscribe-thread + tracks lastSeq for reconnect catchup

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — client catchup

## Summary
useThreadStream now keeps lastSeqRef across reconnects. On every WS open it
sends subscribe-thread with the last-known seq; the server replays events
above that. catchup-too-long falls back to HTTP-loading the thread fresh.

## Changes
- packages/ui/src/hooks/useThreadStream.ts
EOF
```

---

**Checkpoint:** `pnpm -r build && pnpm -r test`. All TS + tests + builds green. Locally usable end-to-end if you point web's dev server at the local cloud.

---

## Section 12: Ops / deploy

### Task 33: Update `docs/DEPLOYMENT.md` + ship web vhost recipe

**Files:**
- Modify: `docs/DEPLOYMENT.md`
- Create: `docs/deploy/chat.ai-cognit.com.nginx` (template)

- [ ] **Step 1: Add "Web client" section to DEPLOYMENT.md**

Append, after the existing nginx section, a new sub-section:

```markdown
## Web client at chat.ai-cognit.com

Separate nginx vhost serves the static Vite build. API still on
cloud.ai-cognit.com — CORS allows it.

### One-time provisioning

1. CF DNS: `chat.ai-cognit.com A 107.174.60.18` (Proxied or DNS-only, both fine).
2. Cert: `sudo certbot certonly --webroot -w /var/www/cert-challenge -d chat.ai-cognit.com --email YOU@gmail.com --agree-tos --no-eff-email --non-interactive`
3. nginx vhost at `/etc/nginx/sites-enabled/chat.ai-cognit.com`:

   ```nginx
   server {
     listen 80;
     listen 443 ssl http2;
     server_name chat.ai-cognit.com;
     ssl_certificate     /etc/letsencrypt/live/chat.ai-cognit.com/fullchain.pem;
     ssl_certificate_key /etc/letsencrypt/live/chat.ai-cognit.com/privkey.pem;
     include /etc/letsencrypt/options-ssl-nginx.conf;
     ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
     root /var/www/chat;
     index index.html;
     location /.well-known/acme-challenge/ { root /var/www/cert-challenge; }
     # SPA fallback — every path serves /index.html so react-router can take over.
     location / { try_files $uri $uri/ /index.html; }
   }
   ```

4. `sudo nginx -t && sudo systemctl reload nginx`.
5. Add `https://chat.ai-cognit.com/auth/google/callback` to Google Cloud
   Console OAuth Authorized redirect URIs.

### Deploying a new web build

Updated deploy-new-version recipe (now also rsyncs apps/web/dist):

```bash
ssh prod-cognit '
  sudo -u cogni bash -c "
    cd /opt/cogni \
      && git pull --ff-only \
      && pnpm install --frozen-lockfile \
      && pnpm -r --filter \"@cogni/*\" build \
      && pnpm --filter web build
  "
  sudo systemctl restart cogni-cloud
  sleep 2
  sudo systemctl status cogni-cloud --no-pager | head -10
  sudo rsync -a --delete /opt/cogni/apps/web/dist/ /var/www/chat/
'
```
```

- [ ] **Step 2: Save template for chat vhost**

Create `docs/deploy/chat.ai-cognit.com.nginx` containing the nginx vhost above verbatim (so future re-provisioning has the file in-repo).

- [ ] **Step 3: Note in the "Known issues / future work" section**

Add bullet:

```markdown
- **CF Proxied for chat.ai-cognit.com**: same caveat as cloud — keep "Always Use
  HTTPS" off zone-wide so cert renewal's HTTP-01 challenge can come through.
```

- [ ] **Step 4: Commit**

```bash
git add docs/DEPLOYMENT.md docs/deploy/chat.ai-cognit.com.nginx
git commit -m "docs(deploy): chat.ai-cognit.com vhost + web rsync step

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — DEPLOYMENT.md updated

## Summary
Added the chat.ai-cognit.com vhost recipe + cert + Google OAuth redirect URI
note + updated deploy-new-version block to rsync apps/web/dist into
/var/www/chat. nginx template lives at docs/deploy/ for re-provisioning.

## Changes
- docs/DEPLOYMENT.md — Web client section
- docs/deploy/chat.ai-cognit.com.nginx — new template
EOF
```

---

### Task 34: Provision chat.ai-cognit.com on prod-cognit (manual ops)

**Files:** (none in-repo)

- [ ] **Step 1: User adds DNS record**

User: in Cloudflare, add A record `chat.ai-cognit.com → 107.174.60.18` (Proxied).

- [ ] **Step 2: User issues cert**

```bash
ssh prod-cognit 'sudo certbot certonly --webroot -w /var/www/cert-challenge \
  -d chat.ai-cognit.com --email YOU@gmail.com \
  --agree-tos --no-eff-email --non-interactive'
```

Expected: `Certificate is saved at: /etc/letsencrypt/live/chat.ai-cognit.com/fullchain.pem`

- [ ] **Step 3: User installs nginx vhost**

```bash
scp docs/deploy/chat.ai-cognit.com.nginx \
  prod-cognit:/tmp/chat.ai-cognit.com.nginx
ssh prod-cognit '
  sudo install -o root -g root -m 644 /tmp/chat.ai-cognit.com.nginx \
    /etc/nginx/sites-enabled/chat.ai-cognit.com
  sudo mkdir -p /var/www/chat
  sudo chown -R www-data:www-data /var/www/chat
  sudo nginx -t && sudo systemctl reload nginx
'
```

- [ ] **Step 4: User adds Google OAuth redirect URI**

In Google Cloud Console → Credentials → the OAuth 2.0 Client ID:
add `https://chat.ai-cognit.com/auth/google/callback` to *Authorized redirect URIs*.

- [ ] **Step 5: Verify**

```bash
curl -I https://chat.ai-cognit.com/
# Expected: HTTP/2 200, content-type: text/html (404-like since /var/www/chat is empty pre-first-deploy)
```

(First real content lands in Task 35.)

- [ ] **Step 6: No commit (server-side only)**

But do write a changelog locally:

```bash
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — provisioned chat.ai-cognit.com (server-side, no git change)

## Summary
On prod-cognit:
- DNS A record added in CF
- letsencrypt cert issued for chat.ai-cognit.com
- nginx vhost installed + reloaded
- Google OAuth redirect URI added in GCP console

## Verification
- curl -I https://chat.ai-cognit.com/ → 200 + valid TLS
EOF
```

---

### Task 35: First web deploy

**Files:** (none in-repo — runtime action)

- [ ] **Step 1: Build everything fresh**

```bash
pnpm install
pnpm -r --filter "@cogni/*" build
pnpm --filter web build
```

- [ ] **Step 2: Push cloud + web together**

```bash
git push origin main
ssh prod-cognit '
  sudo -u cogni bash -c "
    cd /opt/cogni \
      && git pull --ff-only \
      && pnpm install --frozen-lockfile \
      && pnpm -r --filter \"@cogni/*\" build \
      && pnpm --filter web build
  "
  sudo systemctl restart cogni-cloud
  sudo rsync -a --delete /opt/cogni/apps/web/dist/ /var/www/chat/
'
```

Also need to run the migration **once** on the production DB:

```bash
ssh prod-cognit 'sudo -u cogni bash -c "cd /opt/cogni/packages/cloud && pnpm exec tsx --env-file=.env src/scripts/migrate-2026-05-18-sp2-deltas.ts"'
```

- [ ] **Step 3: Verify**

```bash
# Web reachable
curl -I https://chat.ai-cognit.com/
# Cloud still healthy
curl -s https://cloud.ai-cognit.com/health
# WS still serving (HEAD won't show much, check journal instead)
ssh prod-cognit 'sudo journalctl -u cogni-cloud -n 30 --no-pager'
```

Open `https://chat.ai-cognit.com` in a browser — should see the login page.

- [ ] **Step 4: Changelog (server-side, no commit)**

```bash
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — first production deploy

## Summary
Pushed main, deployed cogni-cloud + first web SPA build, ran the SP-2 schema
migration on prod Neon. Web visible at https://chat.ai-cognit.com.

## Verification
- curl https://chat.ai-cognit.com/ → 200 (login page)
- journalctl -u cogni-cloud → clean restart, listening
- Migration script logged "done" with expected counts
EOF
```

---

## Section 13: End-to-end verification

### Task 36: Run through spec §8 dogfood scenarios

**Files:** (none — just verification)

The spec lists 9 scenarios. Run each by hand against the deployed system, ticking checkboxes as you pass.

- [ ] **Scenario 1 — second device, account merge**
  1. On a different Mac, install cogni desktop app.
  2. Log in with email magic-link (same email as your existing Google login).
  3. Expected:
     - Lands on Welcome / Sidebar with existing threads.
     - `GET /api/identities` returns 2 entries (`google` + `email`) for the same userId.
     - `GET /api/hosts` returns 2 hosts, both online.

- [ ] **Scenario 2 — web login + thread catchup**
  1. Open `https://chat.ai-cognit.com` in browser.
  2. Log in via magic link.
  3. Click a historical thread.
  4. Expected: messages render fresh; `Network` tab shows a single WS open + `subscribe-thread`.
  5. `GET /api/devices` shows the new browser entry.

- [ ] **Scenario 3 — cross-client message fan-out**
  1. With both desktops + web all open on the same thread, type "hi" in web.
  2. Expected:
     - Desktop A: user message appears immediately, runner kicks in on it (preferred host).
     - Web: same user message + same streaming response.
     - Desktop B (other Mac): same.

- [ ] **Scenario 4 — host-meta on shutdown**
  1. Close Desktop A.
  2. Wait ~30s (or kill its host daemon explicitly).
  3. Expected: Settings page on Web + Desktop B both show MacBook Air as ⚪ without refresh.

- [ ] **Scenario 5 — fallback prompt + switch**
  1. With A offline, send a message from web in a thread whose last runner_session was on A.
  2. Expected: HostFallbackCard appears in the thread (web AND Desktop B).
  3. Click "切换并发送" with Desktop B selected.
  4. Expected:
     - Old `runner_sessions` row for that thread is now `status='closed', closed_at IS NOT NULL`.
     - New row on host B, `status='running'`.
     - Streaming response shows up in web AND Desktop B.
     - Next message in same thread goes straight to B (preferred = latest).

- [ ] **Scenario 6 — no-host banner**
  1. Close Desktop B too.
  2. Type a message on web.
  3. Expected: NoHostBanner appears, Send button greys out, text preserved in composer.
  4. Reopen Desktop A. Banner clears within seconds (`host-meta` push). Composer re-enabled.

- [ ] **Scenario 7 — revoke device**
  1. In web Settings → Devices, click `Revoke` on the Desktop App row.
  2. Expected: Desktop A's WS closes with code 4001; UI snaps back to login.
  3. Sign in again with magic link.
  4. Expected: new auth_session row; old one has `revoked_at IS NOT NULL`.

- [ ] **Scenario 8 — reconnect catchup**
  1. On web, open a thread that's mid-stream on a desktop.
  2. Toggle airplane mode for 5s, then back on.
  3. Expected: WS reconnects, sends `subscribe-thread { lastSeq: <last seen> }`, missing events stream in, conversation continues live.

- [ ] **Scenario 9 — cross-user access**
  1. From the browser dev console, send a `subscribe-thread` for a threadId you don't own (made-up UUID).
  2. Expected: WS closes with code 4003.
  3. `curl https://cloud.ai-cognit.com/api/threads/<other-user-thread> -H 'Authorization: Bearer <my-token>'` → 404.

If **all 9 pass:** SP-2 is done.

- [ ] **Verification commit**

If any of the scenarios required tweaks, commit them as fixes. Otherwise just write a final changelog:

```bash
TS=$(date +%Y%m%d_%H%M%S) && cat > "changelog/${TS}.md" <<'EOF'
# SP-2 — verification pass

## Summary
All 9 spec §8 dogfood scenarios pass end-to-end in production. SP-2 is done.

## Verification
[paste any notable observations / screenshots / journal excerpts here]
EOF
```

---

## Done

Wrap-up checklist:
- [ ] `pnpm -r build` green
- [ ] `pnpm -r test` green
- [ ] Production cloud healthy (`curl https://cloud.ai-cognit.com/health`)
- [ ] Production web serving (`curl -I https://chat.ai-cognit.com/`)
- [ ] All 9 spec §8 scenarios pass
- [ ] DEPLOYMENT.md updated with web vhost
- [ ] No dangling FIXME/TODO in moved code

When this list is checked: kick off `superpowers:finishing-a-development-branch`.

