/**
 * Migration: add hosts.default_adapter.
 *
 * Idempotent - ADD COLUMN IF NOT EXISTS. The runner host reports its preferred
 * Agent Loop core on register; cloud persists it so Settings can render and
 * future dispatches can use the selected adapter. Defaults to Claude Code for
 * existing hosts.
 *
 * Run with:
 *   pnpm --filter @cogni/cloud exec tsx --env-file=.env \
 *     src/scripts/migrate-2026-06-15-host-default-adapter.ts
 */
import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../env.js";

const env = loadEnv();
const sql = neon(env.databaseUrl);

console.log("[migrate] adding hosts.default_adapter column...");
await sql`ALTER TABLE hosts ADD COLUMN IF NOT EXISTS default_adapter text NOT NULL DEFAULT 'claude-code'`;

const post = await sql`
  SELECT
    (SELECT count(*)::int FROM hosts) AS hosts_n,
    (SELECT count(*)::int FROM hosts WHERE default_adapter = 'codex') AS codex_n
`;
console.log(`[migrate] done - hosts=${post[0]?.hosts_n}, codex_default=${post[0]?.codex_n}`);
process.exit(0);
