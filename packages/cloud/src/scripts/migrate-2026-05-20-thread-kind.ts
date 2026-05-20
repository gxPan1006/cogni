/**
 * Migration: add threads.kind for SP-4 workspace-chat orchestrator threads.
 *
 * Idempotent — ADD COLUMN IF NOT EXISTS with a NOT NULL DEFAULT 'chat', so all
 * existing rows become ordinary chat threads. 'workspace' marks orchestrator
 * threads (workspace-level + project-level), which `WorkspaceChatDomain`
 * claims for send-routing.
 *
 * Run with:
 *   pnpm --filter @cogni/cloud exec tsx --env-file=.env \
 *     src/scripts/migrate-2026-05-20-thread-kind.ts
 */
import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../env.js";

const env = loadEnv();
const sql = neon(env.databaseUrl);

console.log("[migrate] adding threads.kind column…");
await sql`ALTER TABLE threads ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'chat'`;

const post = await sql`
  SELECT
    (SELECT count(*)::int FROM threads) AS threads_n,
    (SELECT count(*)::int FROM threads WHERE kind = 'workspace') AS workspace_n
`;
console.log(`[migrate] done — threads=${post[0]?.threads_n}, workspace=${post[0]?.workspace_n}`);
process.exit(0);
