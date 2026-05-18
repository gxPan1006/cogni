# Design handoff integration notes

Notes from porting `handoff/` into `apps/desktop/src/`. The designer can iterate on these.

## What I had to patch on top of the drop-in

1. **`apps/desktop/src/Conversation.tsx`** — removed the unused `NoHostBanner`
   import. The handoff file imports it, but only references it inside a
   commented-out SP-2 placeholder, which trips `noUnusedLocals` and breaks
   `tsc --noEmit`. Suggest the designer either drop the import or wire the
   stub behind a feature flag so it stays referenced.

2. **`apps/desktop/src/styles/base.css`** — appended a minimal `.layout` /
   `.layout > .main` flex shell at the bottom of the file. Shell.tsx still
   renders `<div className="layout">[Sidebar][<div class="main">…]</div>`,
   but neither `handoff/styles/base.css` nor any `*.css` in `handoff/src/`
   defines those two classes, so the sidebar stretched full-width and Welcome
   slid below it. The block I added is:

   ```css
   html, body, #root { height: 100%; }
   .layout { display: flex; height: 100vh; background: var(--bg); overflow: hidden; }
   .layout > .main { flex: 1; min-width: 0; min-height: 0; display: flex;
                     flex-direction: column; overflow: hidden; }
   ```

   Suggest folding this into `base.css` upstream (or shipping a tiny
   `layout.css`) so the next consumer doesn't trip over it.

3. **Removed `apps/desktop/src/styles/layout.css`** — the file in this repo
   pre-dated the handoff and references tokens (`--sidebar-width`,
   `--bg-app`, `--bg-sidebar`, `--border`) that don't exist in
   `handoff/styles/tokens.css`. Deleted and dropped the import from
   `main.tsx`. The new sidebar owns its own width (`width: 280px` in
   `sidebar.css`) so the global token is no longer needed.

## Things to know

- **Package filter:** `pnpm` filter is `--filter desktop`, not
  `--filter @cogni/desktop` as the README says (the app's `package.json`
  uses the unscoped name).

- **Login can't be tested in `pnpm dev` today.** `useAuth.ts` ships a dev
  fallback that POSTs `/auth/dev-token` and drops you straight into Shell
  whenever the cloud is reachable. I verified Login's TypeScript and CSS
  compile, but the two-column visual will only render in a Tauri build (or
  if the cloud is offline). Worth gating the dev fallback on
  `localStorage.cogni_skip_dev_fallback` so QA can flip it for the Login
  screen.

- **End-to-end streaming isn't fully verified.** I confirmed:
  - WS connects (textarea is not disabled, no danger banner)
  - User message renders as a sand chip with Markdown (`**加粗**` → `<strong>`)
  - Typing-dots indicator shows after submit
  - `本地运行环境未连接` warning banner shows when host is offline
  ...but I don't have a runner-host daemon running locally, so I never saw
  `text-delta` / `tool-call` events come back. The render path in
  `aggregateEvents` matches the contract types exactly, so should JustWork —
  but worth a smoke test on a machine with the daemon running.

- **Project / Artifacts not mounted.** Per the README they're SP-3/SP-4
  reference designs. They live in `src/` so the styles compile, but nothing
  routes to them yet. If the designer wants a dev-only preview, easiest is
  a `?page=project` URL param in Shell.

- **Settings is presentational only.** The handoff already documents which
  endpoints each section needs; once SP-2 lands `/identities`, `/devices`,
  `/hosts`, the page can swap `MOCK_HOSTS` / `MOCK_DEVICES` for live data.
