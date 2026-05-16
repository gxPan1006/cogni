# Running Cogni (SP-1)

This is the local run recipe for the SP-1 "spine": desktop login → chat → cloud
routes to the local Runner Host → Claude Code runs → streaming back to the
desktop. Follow the steps in order.

---

## 1. Prerequisites

Install these on your machine first:

- **Node.js ≥ 20.10** — check with `node --version`.
- **pnpm** — `npm i -g pnpm` (the repo is a pnpm workspace).
- **Rust toolchain** — install via [rustup](https://rustup.rs/); needed to build
  the Tauri desktop app. On macOS you also need Xcode Command Line Tools
  (`xcode-select --install`).
- **`claude` CLI — installed and authenticated.** The Runner Host shells out to
  `claude` to run turns. Install Claude Code, then run `claude` once
  interactively to log in. Verify with `claude --version` and a quick
  `claude --print "hello"`.
- A **Neon** account (free tier is fine) — <https://neon.tech>.
- **Google OAuth credentials** — created in the Google Cloud Console (see
  step 3).

Install workspace dependencies from the repo root:

```sh
pnpm install
```

---

## 2. Set up the Neon database

1. Create a Neon project in the Neon console. Copy its connection string
   (the pooled `postgres://…` URL).
2. Copy the cloud env template and fill in the URL:

   ```sh
   cp packages/cloud/.env.example packages/cloud/.env
   ```

   Edit `packages/cloud/.env` and set `DATABASE_URL` to your Neon URL.
3. Create the tables by pushing the drizzle schema:

   ```sh
   pnpm --filter @cogni/cloud exec drizzle-kit push
   ```

   This creates `tenants`, `users`, `user_identities`, `hosts`, `threads`,
   `messages`, `runner_sessions`, and `events`.

   **Upgrading from a pre-magic-link cloud (had `users.oauth_sub`)?** Run the
   one-off migration to backfill `user_identities` from the legacy column and
   drop it:

   ```sh
   pnpm --filter @cogni/cloud exec tsx --env-file=.env \
     src/scripts/migrate-2026-05-16-add-user-identities.ts
   ```

   The script is idempotent (uses `CREATE TABLE IF NOT EXISTS`,
   `ON CONFLICT DO NOTHING`, `DROP COLUMN IF EXISTS`) and reports a per-user
   diff of what it backfilled — safe to re-run.

---

## 3. Set up Google OAuth

1. In the [Google Cloud Console](https://console.cloud.google.com/), create an
   OAuth 2.0 Client ID of type **Web application**.
2. Add an **Authorized redirect URI**:

   ```
   http://localhost:8787/auth/google/callback
   ```

3. Fill the rest of `packages/cloud/.env`:
   - `GOOGLE_CLIENT_ID` — from the OAuth client.
   - `GOOGLE_CLIENT_SECRET` — from the OAuth client.
   - `JWT_SECRET` — a random secret; generate one with `openssl rand -hex 32`.
   - `PUBLIC_URL` / `PORT` — leave the defaults (`http://localhost:8787` /
     `8787`) for local runs.

---

## 3.5 Set up email magic-link login (optional, recommended)

Magic-link login lets users sign in without Google OAuth — essential when the
runtime network can't reliably reach Google (Chinese mainland over GFW being the
case that prompted this).

**Dev mode (no real emails):** leave `EMAIL_TRANSPORT=console` in `.env` (the
default if you don't set it). The cloud will print the magic URL to stdout
instead of sending an email — copy it from Terminal 1 and run
`open 'cogni://auth?magic=…'` from a shell to deliver the deep link to the
desktop app.

**Production / staging — two real-email paths:**

You can pick either Resend (REST API) or classic SMTP. Both give the same
end-user behaviour (real email arrives in the inbox); SMTP is faster to wire
when you already have a mailbox (e.g. spacemail / postmark / aws-ses-smtp).

**Option A — Resend:**

1. Create a [Resend](https://resend.com) account (free tier covers 3k
   emails/mo — plenty for SP-1).
2. In Resend → Domains, add and verify the domain you want to send from
   (DNS records: SPF + DKIM). Verification usually takes 5-15 min once
   records are propagated.
3. Create an API key (Domains → API Keys → Create).
4. Fill `packages/cloud/.env`:

   ```
   EMAIL_TRANSPORT=resend
   RESEND_API_KEY=re_…
   EMAIL_FROM=Cogni <login@yourdomain.com>
   MAGIC_LINK_TTL_MIN=15
   ```

**Option B — SMTP (nodemailer):**

1. Have an SMTP mailbox handy (any provider — Spacemail, Postmark, AWS SES
   SMTP, Gmail with an app password, etc.).
2. Fill `packages/cloud/.env`:

   ```
   EMAIL_TRANSPORT=smtp
   SMTP_HOST=mail.yourprovider.com
   SMTP_PORT=465                        # 465 = implicit SSL; 587 = STARTTLS
   SMTP_USER=login@yourdomain.com
   SMTP_PASSWORD=...
   EMAIL_FROM=Cogni <login@yourdomain.com>
   # SMTP_SECURE=true                   # optional, defaults from SMTP_PORT
   MAGIC_LINK_TTL_MIN=15
   ```

Then **restart** `pnpm --filter @cogni/cloud dev` (either option).

Rate limits enforced server-side: 1 send/min + 5/hour per email, 3 sends/min +
20/hour per IP. The desktop Login page automatically shows both CTAs (email +
Google) — nothing extra to configure on the client.

---

## 4. Build the workspace packages

The library packages publish their `dist/` (gitignored) as their entry point,
and the runtime tools resolve them from there:

- `pnpm --filter @cogni/cloud dev` (`tsx`) loads `@cogni/contract` + `@cogni/shared`
  from their built `dist/`.
- The desktop app's SP-1 sidecar is a small shell-script wrapper that
  `exec node`s `packages/runner-host/dist/main.js` — that file must exist or the
  daemon won't spawn.

So build all of them once after `pnpm install`:

```sh
pnpm build
```

This builds `contract`, `shared`, `cloud`, and `runner-host` into their `dist/`
dirs. Re-run it whenever you change a `packages/*` source file. (`pnpm test`
needs no build — vitest resolves the workspace packages from source; `pnpm typecheck`
and `pnpm --filter desktop build` build what they need automatically.)

---

## 5. Run it

Open two terminals from the repo root.

**Terminal 1 — cloud control plane (port 8787):**

```sh
pnpm --filter @cogni/cloud dev
```

The `dev` script loads `packages/cloud/.env` automatically (via `tsx --env-file`),
so the `DATABASE_URL`/`JWT_SECRET`/OAuth values you filled in above are picked up.

**Terminal 2 — desktop app:**

```sh
pnpm --filter desktop tauri dev
```

On first launch, log in with Google. The desktop app registers a Runner Host
with the cloud (writing `~/.cogni/host.json`) and spawns the runner-host daemon
(recording its pid in `~/.cogni/daemon.pid`). The daemon connects back to the
cloud over WebSocket; `claude` turns run in `~/.cogni/threads/<threadId>/`.

---

## 6. SP-1 acceptance checklist (manual walkthrough)

Run through these by hand to sign off SP-1. All seven must pass.

1. **桌面 Google 登录** — Click "Login", complete the Google consent screen;
   the app leaves the Login screen and shows the chat shell.
2. **新建 chat** — Click "+ New chat"; a new thread appears under **Recents** in
   the sidebar.
3. **发消息 → 云端路由到本地 Runner Host → Claude Code 跑** — Send a message in
   the thread. The cloud logs (Terminal 1) show a `dispatch` to the host, and
   `claude` runs in `~/.cogni/threads/<threadId>/`.
4. **工具调用 + 文本流式回桌面** — The conversation shows streaming assistant
   text and 🔧 tool blocks as the turn progresses.
5. **thread / 消息持久化在 Neon** — Query Neon: `threads`, `messages`, and
   `events` all have rows for the conversation.
6. **关 app 重开,Recents 还在、能续聊** — Quit and relaunch the desktop app;
   the thread is still in Recents, and sending another message resumes the
   conversation (the dispatch carries the stored `runnerSessionId`).
7. **host 离线空态** — Quit the runner-host daemon
   (`kill $(cat ~/.cogni/daemon.pid)`); the conversation shows the yellow
   "本地运行环境未连接" banner.
8. **邮件 magic-link 登录** — Logout (sidebar menu), and on the Login page
   enter a fresh email address (anything that hasn't been used before) and
   click "发送登录链接". The hero swaps to the "已发送…" card with a 60s resend
   countdown. With `EMAIL_TRANSPORT=console`, copy the `cogni://auth?magic=…`
   URL printed in Terminal 1 and run `open '<url>'` in any shell; the desktop
   app should drop straight into Welcome. Then click "发送登录链接" a second
   time within a minute and verify the form surfaces a red error
   (`POST .../auth/email/send → 429` — proves the rate limiter is wired in).
9. **同一 email 在 Google 和 magic link 间复用同一身份** — Sign in via Google
   first, note the email, logout, then sign in via magic-link with the same
   email. The Recents list should be identical across both logins. In Neon:
   `SELECT * FROM users WHERE email = '<that-email>';` returns exactly one
   row, and `SELECT * FROM user_identities WHERE user_id = '<that-id>';`
   shows both `google|<sub>` and `email|<that-email>` rows.

---

## 7. Automated checks

The automated gate (run from the repo root):

```sh
pnpm test        # full vitest suite, all packages
pnpm typecheck   # tsc --noEmit across all TS packages
```

Optional, slower:

```sh
pnpm --filter desktop build              # tsc + vite build of the desktop UI
(cd apps/desktop/src-tauri && cargo check)  # Tauri Rust crate
```

> Note: the cloud's `server.e2e.test.ts` emits one benign warn-level log line
> during teardown (`"host-ws onClose failed" / "PGlite is closed"`). This is a
> known, harmless test-teardown artifact — the test still passes.

---

## Troubleshooting

- **Daemon won't start** — make sure step 4 ran (`packages/runner-host/dist/main.js`
  exists). Check `~/.cogni/host.json` exists; if not, log out and back in.
- **`claude` errors** — confirm `claude` is on `PATH` and authenticated
  (`claude --print "hello"` works from a plain shell).
- **OAuth redirect mismatch** — the redirect URI in the Google console must be
  exactly `http://localhost:8787/auth/google/callback`.
- **Reset local host state** — delete `~/.cogni/` and log in again to
  re-register the host from scratch.
- **Google OAuth unreachable / stuck on `accounts.google.com`** — the OAuth
  redirect itself goes through Google's SPA, which pulls assets from
  `gstatic.com` and friends; flaky networks can stall it. While you're sorting
  the network out, you can bypass login locally by signing a JWT directly:

  ```sh
  cd packages/cloud
  COGNI_DEV_TOKEN_ACK=yes pnpm exec tsx --env-file=.env src/scripts/mint-dev-token.ts
  ```

  This creates/finds a stand-in user (`oauthSub=dev|manual`,
  `email=dev-manual@local.test`) in Neon, then prints a 30-day JWT for them.
  In the Tauri webview's Safari Web Inspector (Develop → Cogni → Console), paste
  `localStorage.setItem('cogni_token', '<the JWT>'); location.reload();` to
  drop into the chat shell. The script refuses to run with `NODE_ENV=production`
  and requires `COGNI_DEV_TOKEN_ACK=yes` — it is never meant for real users.
