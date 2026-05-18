# Cogni Cloud Deployment

Production cloud lives at `https://cloud.ai-cognit.com`, served by **prod-cognit** (RackNerd VPS, `107.174.60.18`). This doc is the runbook for ops, plus the recipe for re-provisioning from scratch.

---

## Current production topology

```
┌────────── Mac (desktop dogfood) ─────────┐    ┌─── any browser (web) ───┐
│  apps/desktop, VITE_CLOUD_URL =          │    │ https://chat.ai-cognit  │
│  https://cloud.ai-cognit.com             │    │ .com (apps/web SPA)     │
└──────────────────────┬───────────────────┘    └────────────┬────────────┘
                       │                                     │ XHR/WS to cloud.*
                       │  POST / WS over HTTPS               │ (CORS allows it)
              ┌────────▼─────────────────────────────────────▼────┐
              │ Cloudflare ai-cognit.com zone                     │  TLS termination
              │   cloud.*  Proxied (orange)                       │  + DDoS / anycast
              │   chat.*   Proxied (orange)                       │
              └────────┬───────────────────────────┬──────────────┘
                       │ HTTPS to origin           │ HTTPS to origin
              ┌────────▼────────────────┐ ┌────────▼─────────────────────┐
              │ prod-cognit nginx       │ │ prod-cognit nginx            │
              │ vhost cloud.ai-cognit   │ │ vhost chat.ai-cognit         │
              │ /etc/nginx/sites-       │ │ /etc/nginx/sites-            │
              │ enabled/cloud.ai-...    │ │ enabled/chat.ai-...          │
              │ → proxies localhost:8787│ │ → serves static /var/www/chat│
              │   WS upgrade supported  │ │   (apps/web vite build)      │
              │                         │ │   SPA fallback to index.html │
              └────────┬────────────────┘ └──────────────────────────────┘
                       │  HTTP loopback
              ┌────────▼────────────────────────────┐
              │ cogni-cloud systemd service         │ /etc/systemd/system/cogni-cloud.service
              │ Node 22, runs as user `cogni`       │ binary at /opt/cogni/packages/cloud/dist/main.js
              │ EnvironmentFile=/opt/cogni/         │ Restart=always, auto-starts at boot.
              │   packages/cloud/.env               │
              └─┬────┬────────────────┬─────────────┘
                │    │                │
        ┌───────▼┐   │   ┌────────────▼─────────────┐
        │ Neon   │   │   │ SMTP mail.spacemail.com │
        │ Postgres│  │   │ :465 SMTPS — direct from│
        │ TLS 443│   │   │ prod-cognit (no tunnel) │
        └────────┘   │   └─────────────────────────┘
                     │
            ┌────────▼─────────────┐
            │ Google OAuth         │
            │ accounts.google.com  │
            │ TLS 443              │
            └──────────────────────┘
```

**Two domains, one cloud, one VPS.** `cloud.ai-cognit.com` proxies API + WS
to the Node service on `:8787`. `chat.ai-cognit.com` serves the static SPA
build out of `/var/www/chat/`; the SPA's JS calls back to `cloud.*` via
CORS (allowlist in `packages/cloud/src/server.ts`). Desktop app talks
directly to `cloud.*` over WS and never touches `chat.*`.

---

## Day-to-day ops

All these run from your local Mac via the `prod-cognit` SSH alias.

### Tail logs

```bash
ssh prod-cognit 'sudo journalctl -u cogni-cloud -f'
```

### Check status

```bash
ssh prod-cognit 'sudo systemctl status cogni-cloud --no-pager'
```

### Deploy a new version

`cogni` user holds the checkout at `/opt/cogni`. Read-only GitHub deploy key (id_ed25519 in `~cogni/.ssh/`).

Two things deploy together: the cloud Node service (restart) and the web SPA
static build (rsync to nginx-served path). They share the same git pull.

```bash
ssh prod-cognit '
  sudo -u cogni bash -c "
    cd /opt/cogni \
      && git pull --ff-only \
      && pnpm install --frozen-lockfile \
      && pnpm -r --filter \"@cogni/*\" build \
      && pnpm --filter web build
  "
  # cloud (restart picks up new dist + applies any new JWT signing logic,
  # which means every active JWT is rejected and users get bounced to login)
  sudo systemctl restart cogni-cloud
  sleep 2
  sudo systemctl status cogni-cloud --no-pager | head -10
  # web (static SPA — rsync atomic-ish replace into nginx-served root)
  sudo rsync -a --delete /opt/cogni/apps/web/dist/ /var/www/chat/
  sudo chown -R www-data:www-data /var/www/chat
'
```

### Run a schema migration

Migrations live under `packages/cloud/src/scripts/migrate-*.ts`. Each is
idempotent so re-running is safe. Run on prod with the cogni user (which has
the right `.env`):

```bash
ssh prod-cognit 'sudo -u cogni bash -c "cd /opt/cogni/packages/cloud && pnpm exec tsx --env-file=.env src/scripts/migrate-YYYY-MM-DD-NAME.ts"'
```

SP-2 added one: `migrate-2026-05-18-sp2-deltas.ts` (drops `runner_sessions`
thread_id uniqueness + adds `closed_at`, creates `auth_sessions` table, adds
`hosts.removed_at`). Run it **once** before restarting cogni-cloud with the
SP-2 code.

### Rotate JWT_SECRET

Invalidates all existing JWTs (every user has to log in again).

```bash
NEW=$(openssl rand -hex 32)
ssh prod-cognit "sudo sed -i 's/^JWT_SECRET=.*/JWT_SECRET=$NEW/' /opt/cogni/packages/cloud/.env && sudo systemctl restart cogni-cloud"
```

### Cert renewal

certbot has a systemd timer (`certbot.timer`) that auto-renews ~30 days before expiry. After renewal certbot runs `nginx -s reload` automatically. No manual action needed.

To check or force:

```bash
ssh prod-cognit 'sudo certbot certificates'
ssh prod-cognit 'sudo certbot renew --dry-run'   # test
```

---

## chat.ai-cognit.com (web SPA) provisioning

The web vhost is separate from cloud.ai-cognit.com so we can iterate on the
SPA without touching the running API. The full hand-off-friendly recipe lives
at [`SP-2-OPS-MANUAL.md`](SP-2-OPS-MANUAL.md) (DNS / cert / nginx / GCP
OAuth, with verification commands at each step). The condensed version:

1. **CF DNS**: A record `chat.ai-cognit.com → 107.174.60.18`, Proxied.
2. **TLS**: `sudo certbot certonly --webroot -w /var/www/cert-challenge -d chat.ai-cognit.com --email YOU@gmail.com --agree-tos --no-eff-email --non-interactive`
3. **nginx vhost**: copy [`docs/deploy/chat.ai-cognit.com.nginx`](deploy/chat.ai-cognit.com.nginx)
   → `/etc/nginx/sites-enabled/chat.ai-cognit.com`. Make sure
   `/var/www/chat/` exists and is `chown www-data:www-data`. Then
   `sudo nginx -t && sudo systemctl reload nginx`.
4. **GCP OAuth Console**: add `https://chat.ai-cognit.com/auth/google/callback`
   to the same OAuth Client ID's *Authorized redirect URIs*. Keep the existing
   `https://cloud.ai-cognit.com/auth/google/callback` (used by desktop's
   cogni:// → cloud → desktop deep-link flow).
5. **Verify**: `curl -sI https://chat.ai-cognit.com/` → `HTTP/2 200`.

After provisioning, run the standard "Deploy a new version" recipe above — it
rsyncs `apps/web/dist/` into `/var/www/chat/`.

---

## From-scratch provisioning recipe

This documents what was done on 2026-05-18. Reference it if you need to re-provision prod-cognit or set up another VPS.

### Prerequisites you must do manually

1. **Cloudflare DNS**: add A records for **both** subdomains pointing at the
   VPS IP. Proxy = orange (Proxied) for CF TLS + DDoS:
   - `cloud.ai-cognit.com → 107.174.60.18`
   - `chat.ai-cognit.com → 107.174.60.18`

2. **GitHub deploy key**: a read-only SSH key from prod-cognit's `cogni` user must be added to the repo's deploy keys (created automatically by the script below, but the public key needs to land in github via `gh repo deploy-key add` or the UI).

3. **Google OAuth**: in [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → your OAuth 2.0 Client ID, add **both** redirect URIs to *Authorized redirect URIs*:
   - `https://cloud.ai-cognit.com/auth/google/callback` (desktop flow — `cogni://` deep link reaches it via the cloud)
   - `https://chat.ai-cognit.com/auth/google/callback` (web flow — browser lands here, SPA reads the token from the URL fragment)
   (Skip if you only need magic-link login.)

### Network quirk: RESIDENTIAL_PROXY chain

prod-cognit has a preexisting nftables chain `RESIDENTIAL_PROXY` (in `table ip nat`) that intercepts all outbound TCP to ports 80/443 and DNATs to a residential SOCKS proxy at `:12346`. The proxy backend is currently dead, so any unbypassed 80/443 outbound times out.

Bypasses we install:
- `meta skuid 0 return` (root) — for apt / curl / certbot ops
- `meta skuid 42 return` (_apt user) — apt's sandboxed download workers
- `meta skuid 999 return` (cogni user) — for cogni-cloud's runtime (Neon, Google OAuth)

**The cogni-UID bypass is auto-reinjected by `cogni-cloud.service`'s `ExecStartPre`** so it survives any sequence of:
- service restart (`systemctl restart cogni-cloud`)
- chain re-creation by whatever loads RESIDENTIAL_PROXY
- machine reboot (where chain might or might not be re-loaded)

The root + `_apt` bypasses are NOT auto-reinjected — they're operational conveniences. Re-add them on demand if the chain comes back fresh:

```bash
ssh prod-cognit 'sudo nft insert rule ip nat RESIDENTIAL_PROXY meta skuid 42 counter return'
ssh prod-cognit 'sudo nft insert rule ip nat RESIDENTIAL_PROXY meta skuid 0 counter return'
```

If the RESIDENTIAL_PROXY chain itself doesn't survive reboot (it lives only in kernel memory, no `/etc/iptables/rules.v4` entry), then port 80/443 outbound just works — no bypass needed.

### Full from-scratch script

```bash
ssh prod-cognit '
  set -e

  # Bypass apt sandbox + root before installing anything
  sudo nft insert rule ip nat RESIDENTIAL_PROXY meta skuid 0 counter return
  sudo nft insert rule ip nat RESIDENTIAL_PROXY meta skuid 42 counter return

  # Force apt to use IPv4 (IPv6 outbound on this VPS is busted)
  echo "Acquire::ForceIPv4 \"true\";" | sudo tee /etc/apt/apt.conf.d/99force-ipv4

  # Node 22 LTS via nodesource
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs certbot python3-certbot-nginx

  # pnpm via corepack — pin to 10.x (11.x is stricter about ignored build scripts
  # and will fail on workspace recursive builds).
  sudo corepack enable

  # cogni system user + writable target dir
  sudo useradd -r -s /bin/bash -m -d /home/cogni cogni || true
  sudo nft insert rule ip nat RESIDENTIAL_PROXY meta skuid $(id -u cogni) counter return
  sudo mkdir -p /opt/cogni && sudo chown cogni:cogni /opt/cogni

  # Deploy key
  sudo -u cogni ssh-keygen -t ed25519 -N "" -f /home/cogni/.ssh/id_ed25519 \
    -C "cogni@prod-cognit deploy key"
  sudo -u cogni bash -c "ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null"
  # → take /home/cogni/.ssh/id_ed25519.pub and:
  #     gh repo deploy-key add - --repo gxPan1006/cogni --title "prod-cognit" --allow-write=false <<<"$PUBKEY"

  sudo -u cogni bash -c "cd /opt/cogni && git clone git@github.com:gxPan1006/cogni.git ."
  sudo -u cogni bash -c "corepack prepare pnpm@10.33.0 --activate"
  sudo -u cogni bash -c "cd /opt/cogni && pnpm install --frozen-lockfile && pnpm -r --filter \"@cogni/*\" build"
'
```

Then push `.env`, systemd unit, and nginx vhost from your local machine (templates in repo at `docs/deploy/`, in-tree examples shown in this doc above).

```bash
scp /tmp/cogni-cloud.env prod-cognit:/tmp/
scp /tmp/cogni-cloud.service prod-cognit:/tmp/
scp /tmp/cloud.ai-cognit.com.nginx prod-cognit:/tmp/

ssh prod-cognit '
  sudo install -o cogni -g cogni -m 600 /tmp/cogni-cloud.env /opt/cogni/packages/cloud/.env
  sudo install -o root  -g root  -m 644 /tmp/cogni-cloud.service /etc/systemd/system/cogni-cloud.service
  sudo install -o root  -g root  -m 644 /tmp/cloud.ai-cognit.com.nginx /etc/nginx/sites-enabled/cloud.ai-cognit.com

  sudo mkdir -p /var/www/cert-challenge
  sudo certbot certonly --webroot -w /var/www/cert-challenge \
    -d cloud.ai-cognit.com --email YOU@gmail.com \
    --agree-tos --no-eff-email --non-interactive

  sudo nginx -t && sudo systemctl reload nginx
  sudo systemctl daemon-reload
  sudo systemctl enable --now cogni-cloud
'
```

### `.env` template for prod

```sh
NODE_ENV=production
PORT=8787
PUBLIC_URL=https://cloud.ai-cognit.com
# SP-2: where the web SPA lives. Cloud uses it to build the Google
# redirect_uri and the magic-link URL when the user came from web.
WEB_URL=https://chat.ai-cognit.com

DATABASE_URL=postgresql://...neon...?sslmode=require
JWT_SECRET=<32-byte hex>
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

EMAIL_TRANSPORT=smtp
SMTP_HOST=mail.spacemail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=us@ai-cognit.com
SMTP_PASSWORD=<your-password>
EMAIL_FROM=Cogni <us@ai-cognit.com>
MAGIC_LINK_TTL_MIN=15
```

No `SMTP_TLS_SERVERNAME` — that's only for the dev-via-tunnel scenario.

`WEB_URL` defaults to `https://chat.ai-cognit.com` if unset, so this var is
only strictly required when serving a non-default web origin (staging, etc).

---

## Known issues / future work

- **`/health` exists but very thin** — `GET /health` returns `{"ok":true}` if the Node process is up. It does NOT exercise the DB, the host registry, or the email transport. Real health/alerting (DB ping + auth_sessions select + transport last-success time) is a follow-up.
- **Single-node assumption** — cogni-cloud's in-memory `ClientHub` + `HostRouter` + magic-link `pending` Map + `RateLimiter` + `pendingFallbacks` (chat domain) all hold transient state in the Node process. Horizontal scale needs these moved to Redis pub/sub or pg LISTEN/NOTIFY. SP-2 is fine on one node; revisit when concurrent active users > ~50.
- **Cert renewal across CF Proxied**: certbot's HTTP-01 challenge relies on CF passing `/.well-known/acme-challenge/*` through cleartext. If you flip Cloudflare zone-wide to "Always Use HTTPS", renewal will start failing — switch to DNS-01 with a CF API token at that point. (Applies to both `cloud.*` and `chat.*`.)
- **No CI/CD**: deploys are manual via the recipe above. Future: GitHub Action that on push-to-main does `pnpm build` + ssh-deploy + rsync web. SP-2 explicitly punted this.
- **JWT migration impact on deploy** — every SP-2 cloud restart that introduces the `sessionId` claim (i.e. the first one) makes every existing SP-1 JWT invalid (no sessionId → `verifyToken` returns null → 401). Users get bounced to login. Expected one-time cost; communicate before the deploy window if it matters. (Re-running an already-SP-2 cloud is a no-op for JWTs.)
- **server.e2e.test.ts intermittent ECONNREFUSED** under concurrent `pnpm vitest run packages/cloud` — port-reuse race between worktrees. Passes 1/1 in isolation. Documented in `docs/integration-log.md` SP-2 batch 2 lessons. Not blocking deploy; fix is to teach the e2e to pick a random free port or sequentialize via `--pool=forks --poolOptions.forks.singleFork`.
