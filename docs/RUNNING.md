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

   This creates `tenants`, `users`, `hosts`, `threads`, `messages`,
   `runner_sessions`, and `events`.

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

## 4. Build the Runner Host

The desktop app's SP-1 sidecar is a small shell-script wrapper that
`exec node`s `packages/runner-host/dist/main.js`. That file must exist before
you launch the desktop app, or the daemon will fail to spawn:

```sh
pnpm --filter @cogni/runner-host build
```

This produces `packages/runner-host/dist/main.js`. Re-run it whenever you
change `packages/runner-host` source.

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
