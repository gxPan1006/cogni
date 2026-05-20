/**
 * Migration: add hosts.projects_root + hosts.projects_root_locked.
 *
 * Idempotent — ADD COLUMN IF NOT EXISTS. SP-4 default-project-folder: the host
 * reports its configured projects-root on the `register` frame; the cloud
 * persists it here so NewProject can pre-fill the repo path. `projects_root`
 * NULL ⇢ old host that never reported one (no pre-fill). `projects_root_locked`
 * mirrors the host's COGNI_PROJECTS_ROOT env pin.
 *
 * Run with:
 *   pnpm --filter @cogni/cloud exec tsx --env-file=.env \
 *     src/scripts/migrate-2026-05-20-host-projects-root.ts
 */
import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../env.js";

const env = loadEnv();
const sql = neon(env.databaseUrl);

console.log("[migrate] adding hosts.projects_root + projects_root_locked columns…");
await sql`ALTER TABLE hosts ADD COLUMN IF NOT EXISTS projects_root text`;
await sql`ALTER TABLE hosts ADD COLUMN IF NOT EXISTS projects_root_locked boolean NOT NULL DEFAULT false`;

const post = await sql`
  SELECT
    (SELECT count(*)::int FROM hosts) AS hosts_n,
    (SELECT count(*)::int FROM hosts WHERE projects_root IS NOT NULL) AS with_root_n
`;
console.log(`[migrate] done — hosts=${post[0]?.hosts_n}, with_projects_root=${post[0]?.with_root_n}`);
process.exit(0);
