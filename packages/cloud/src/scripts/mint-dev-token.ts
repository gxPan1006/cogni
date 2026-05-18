// Dev-only: skips OAuth by directly creating a user in Neon and minting a JWT
// for it. Use only while OAuth is unavailable (e.g. flaky GFW → Google).
//
// Two refusals guard accidental use:
//   1. NODE_ENV=production aborts unconditionally (defense in depth — the
//      production build should never include this script, but if it slips in,
//      it still won't run).
//   2. COGNI_DEV_TOKEN_ACK=yes is required — forces the operator to acknowledge
//      they're bypassing auth for a real user row in the DB.
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
// SP-2: every JWT needs an auth_session row so WS handshake's revoke check has
// something to look up. This dev-token script creates a fresh session each run.
const { createAuthSession } = await import("../db/auth-sessions.js");
const session = await createAuthSession(db, {
  userId: user.id,
  deviceName: "Desktop App (dev — mint-dev-token)",
});
const token = await auth.issueToken({
  userId: user.id,
  tenantId: user.tenantId,
  sessionId: session.id,
});
console.log(token);
process.exit(0);
