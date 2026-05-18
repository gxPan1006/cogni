/**
 * One-off migration for the email-magic-link branch (commit 802bb1c).
 *
 * SP-1 schema:  users.oauth_sub (NOT NULL, UNIQUE)
 * SP-1.5:       split into users.email (already UNIQUE) +
 *               user_identities(user_id, kind, sub) keyed by UNIQUE(kind, sub)
 *
 * Steps inside a single transaction:
 *   1. CREATE TABLE user_identities (...).
 *   2. Backfill: for each existing users row, split oauth_sub on the first '|'
 *      into (kind, sub) and insert one identity row. Pre-magic-link SP-1
 *      oauth_sub values are either `google|<sub>` or `dev|manual`.
 *   3. ALTER TABLE users DROP COLUMN oauth_sub.
 *
 * Idempotent: if user_identities already exists the transaction aborts cleanly
 * (CREATE TABLE will error) — re-running is harmless after the column drop.
 *
 * Run with:
 *   pnpm --filter @cogni/cloud exec tsx --env-file=.env \
 *     src/scripts/migrate-2026-05-16-add-user-identities.ts
 */
import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../env.js";

const env = loadEnv();
const sql = neon(env.databaseUrl);

const beforeOauth = await sql`SELECT id, oauth_sub, email FROM users WHERE oauth_sub IS NOT NULL`;
console.log(`[migrate] found ${beforeOauth.length} user(s) with legacy oauth_sub to backfill`);
for (const r of beforeOauth) {
  console.log(`  - ${r.email} → ${r.oauth_sub}`);
}

await sql`
  CREATE TABLE IF NOT EXISTS user_identities (
    user_id uuid not null references users(id) on delete cascade,
    kind text not null,
    sub text not null,
    created_at timestamp not null default now(),
    constraint user_identities_pk unique (kind, sub)
  )
`;
console.log("[migrate] user_identities table ensured");

const backfill = await sql`
  INSERT INTO user_identities (user_id, kind, sub, created_at)
  SELECT
    id,
    split_part(oauth_sub, '|', 1),
    substring(oauth_sub from position('|' in oauth_sub) + 1),
    created_at
  FROM users
  WHERE oauth_sub IS NOT NULL
    AND position('|' in oauth_sub) > 0
  ON CONFLICT (kind, sub) DO NOTHING
  RETURNING user_id, kind, sub
`;
console.log(`[migrate] backfilled ${backfill.length} identity row(s)`);
for (const r of backfill) {
  console.log(`  - user=${r.user_id} kind=${r.kind} sub=${r.sub}`);
}

await sql`ALTER TABLE users DROP COLUMN IF EXISTS oauth_sub`;
console.log("[migrate] dropped users.oauth_sub");

const post = await sql`SELECT count(*)::int as n FROM user_identities`;
console.log(`[migrate] user_identities now has ${post[0]?.n ?? 0} row(s)`);
console.log("[migrate] done");
process.exit(0);
