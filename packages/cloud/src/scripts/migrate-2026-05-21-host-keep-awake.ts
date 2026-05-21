/**
 * Migration: add hosts.keep_awake + hosts.keep_awake_locked.
 *
 * Idempotent — ADD COLUMN IF NOT EXISTS. Block-sleep toggle: the host reports
 * whether it keeps the machine awake on the `register` frame; the cloud
 * persists it here so Settings → Runner Hosts can show/toggle it. Defaults ON
 * (existing hosts keep the machine reachable for remote clients).
 * `keep_awake_locked` mirrors the host's COGNI_KEEP_AWAKE env pin.
 *
 * Run with:
 *   pnpm --filter @cogni/cloud exec tsx --env-file=.env \
 *     src/scripts/migrate-2026-05-21-host-keep-awake.ts
 */
import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../env.js";

const env = loadEnv();
const sql = neon(env.databaseUrl);

console.log("[migrate] adding hosts.keep_awake + keep_awake_locked columns…");
await sql`ALTER TABLE hosts ADD COLUMN IF NOT EXISTS keep_awake boolean NOT NULL DEFAULT true`;
await sql`ALTER TABLE hosts ADD COLUMN IF NOT EXISTS keep_awake_locked boolean NOT NULL DEFAULT false`;

const post = await sql`
  SELECT
    (SELECT count(*)::int FROM hosts) AS hosts_n,
    (SELECT count(*)::int FROM hosts WHERE keep_awake) AS keep_awake_n
`;
console.log(`[migrate] done — hosts=${post[0]?.hosts_n}, keep_awake_on=${post[0]?.keep_awake_n}`);
process.exit(0);
