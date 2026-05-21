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
