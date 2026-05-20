/**
 * Migration: add messages.attachments_json for file-upload attachment metadata.
 *
 * Idempotent — ADD COLUMN IF NOT EXISTS, nullable jsonb. Stores `[{name,size}]`
 * for messages the user sent with attachments so the chat bubble can re-render
 * file chips after reload. Bytes themselves live on the host's disk, never in
 * the cloud — this column is metadata only.
 *
 * MUST run before restarting the cloud on a build that includes the upload
 * feature: `appendMessage` writes this column on every message insert, so a
 * missing column would break sends.
 *
 * Run with:
 *   pnpm --filter @cogni/cloud exec tsx --env-file=.env \
 *     src/scripts/migrate-2026-05-20-message-attachments.ts
 */
import { neon } from "@neondatabase/serverless";
import { loadEnv } from "../env.js";

const env = loadEnv();
const sql = neon(env.databaseUrl);

console.log("[migrate] adding messages.attachments_json column…");
await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments_json jsonb`;

const post = await sql`SELECT count(*)::int AS messages_n FROM messages`;
console.log(`[migrate] done — messages=${post[0]?.messages_n}`);
process.exit(0);
