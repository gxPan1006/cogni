# Cogni Cloud Deployment

Production cloud lives at `https://cloud.ai-cognit.com`, served by **prod-cognit** (RackNerd VPS, `107.174.60.18`). This doc is the runbook for ops, plus the recipe for re-provisioning from scratch.

---

## Current production topology

```
┌────────── Mac (desktop dogfood) ─────────┐
│  apps/desktop, VITE_CLOUD_URL =          │
│  https://cloud.ai-cognit.com             │ POST / WS over HTTPS
└──────────────────────┬───────────────────┘
                       │
              ┌────────▼────────┐
              │ Cloudflare      │  TLS termination, DDoS, anycast.
              │ ai-cognit.com   │  `cloud.*` is *Proxied* (orange cloud).
              │ zone            │
              └────────┬────────┘
                       │  HTTPS to origin (Full SSL, letsencrypt cert)
              ┌────────▼────────────────────────────┐
              │ prod-cognit nginx                   │ /etc/nginx/sites-enabled/cloud.ai-cognit.com
              │ vhost cloud.ai-cognit.com           │ listens 80 + 443 (TLS), proxies to localhost:8787,
              │                                     │ WebSocket upgrade supported (Hono node-ws).
              └────────┬────────────────────────────┘
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

```bash
ssh prod-cognit '
  sudo -u cogni bash -c "
    cd /opt/cogni \
      && git pull --ff-only \
      && pnpm install --frozen-lockfile \
      && pnpm -r --filter \"@cogni/*\" build
  "
  sudo systemctl restart cogni-cloud
  sleep 2
  sudo systemctl status cogni-cloud --no-pager | head -10
'
```

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

## From-scratch provisioning recipe

This documents what was done on 2026-05-18. Reference it if you need to re-provision prod-cognit or set up another VPS.

### Prerequisites you must do manually

1. **Cloudflare DNS**: add A record `cloud.ai-cognit.com → 107.174.60.18`, set Proxy = orange cloud (Proxied) for CF DDoS + TLS, *or* gray cloud (DNS only) for plain origin TLS. Either works — current setup is orange.

2. **GitHub deploy key**: a read-only SSH key from prod-cognit's `cogni` user must be added to the repo's deploy keys (created automatically by the script below, but the public key needs to land in github via `gh repo deploy-key add` or the UI).

3. **Google OAuth**: in [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → your OAuth 2.0 Client ID, add `https://cloud.ai-cognit.com/auth/google/callback` to *Authorized redirect URIs*. (Skip if you only need magic-link login.)

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

---

## Known issues / future work

- **No HTTPS health endpoint**: cogni-cloud doesn't expose `/healthz` yet. CF (or any monitor) can only tell "is 443 open" via a generic root probe (which returns 404 from Hono — that's still "alive"). Add an explicit health route when we wire up alerting.
- **Cogni-cloud writes nothing to disk** (DB is Neon). One copy of cloud is fine for SP-1; SP-2 horizontal scale will need the in-process `pending` token Map + RateLimiter moved into Redis or pg.
- **Cert renewal across CF Proxied**: certbot's HTTP-01 challenge currently relies on CF passing `/.well-known/acme-challenge/*` through cleartext. If you flip Cloudflare zone-wide to "Always Use HTTPS", the renewal will start failing — switch to DNS-01 with a CF API token at that point.
- **No CI/CD**: deploys are manual via the `git pull && pnpm build && systemctl restart` recipe above. SP-2 should add a GitHub Action that does this on push to main.
