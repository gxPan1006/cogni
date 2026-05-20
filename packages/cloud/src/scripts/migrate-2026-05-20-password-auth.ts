/**
 * Email + password auth migration: add the password hash column.
 *
 * Idempotent — ADD COLUMN IF NOT EXISTS. Safe to re-run.
 *
 * Schema delta:
 *   • users: add password_hash text (null = no password set; Google /
 *     magic-link-only users). The matching `kind='password'` user_identities
 *     rows are written at runtime by the password routes, not here.
 *
 * Run BEFORE restarting cogni-cloud with the password-auth code (the new
 * login/register paths SELECT users.password_hash).
 *
 * Run with:
 *   pnpm --filter @cogni/cloud exec tsx --env-file=.env \
 *     src/scripts/migrate-2026-05-20-password-auth.ts
 */
import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../env.js";

const env = loadEnv();
const sql = neon(env.databaseUrl);

console.log("[migrate] adding users.password_hash column…");
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text`;

const post = await sql`
  SELECT
    (SELECT count(*)::int FROM users) AS users_n,
    (SELECT count(*)::int FROM users WHERE password_hash IS NOT NULL) AS with_password_n
`;
console.log(`[migrate] done — users=${post[0]?.users_n}, with_password=${post[0]?.with_password_n}`);
process.exit(0);
