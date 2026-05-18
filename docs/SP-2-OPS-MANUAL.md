# SP-2 部署手动操作指南

> **给你(另一个 AI / 操作员)的任务清单。** 跟着步骤走、每步都有验证命令、有问题往下翻 troubleshooting。完成所有步骤后 → 通知发起人,我会做剩下的 cloud 部署 (T35) + 验收 (T36)。
>
> **预计总用时:** 15-25 分钟(网络快 + 没踩坑的情况下)。
>
> **前置条件:**
> - SSH 能连 `prod-cognit`(主机 alias 已经在 ~/.ssh/config 里配好)
> - 有权限改 Cloudflare DNS for `ai-cognit.com` 域(管理员账号)
> - 有权限改 Google Cloud Console 的 OAuth Client 配置(项目所有者账号)
> - 你**不需要** push 代码或动 git;cogni-cloud + apps/web 的部署是发起人(我)做的

---

## 任务一览(按顺序)

1. **DNS** — Cloudflare 加 A 记录 `chat.ai-cognit.com → 107.174.60.18`
2. **TLS 证书** — `certbot` 在 prod-cognit 签 `chat.ai-cognit.com` 证书
3. **nginx vhost** — 装新 vhost 服务 web SPA 的静态文件
4. **Google OAuth** — GCP Console 加 `https://chat.ai-cognit.com/auth/google/callback` 到 Authorized redirect URIs
5. **冒烟测试** — `curl -I https://chat.ai-cognit.com/` 应该 200

完成后:**回报发起人**。

---

## 任务 1 · Cloudflare DNS

### 目标
让 `chat.ai-cognit.com` 解析到 prod-cognit 的公网 IP `107.174.60.18`。

### 步骤
1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进 `ai-cognit.com` zone → 左侧 "DNS" → "Records"
3. 点 "Add record":
   - **Type:** `A`
   - **Name:** `chat`(完整就是 `chat.ai-cognit.com`)
   - **IPv4 address:** `107.174.60.18`
   - **Proxy status:** Proxied(橙色云) ← 跟现存的 `cloud.ai-cognit.com` 保持一致
   - **TTL:** Auto
4. 保存

### 验证
等 ~30 秒,然后:
```bash
dig @1.1.1.1 +short chat.ai-cognit.com
```

**预期输出:** 几个 Cloudflare 边缘 IP(`172.66.x.x` / `104.21.x.x` 之类,**不是** `107.174.60.18` —— 因为走了 CF 代理,这正常)。

如果输出空 → 等久点或检查记录是不是真存了。

---

## 任务 2 · TLS 证书

### 目标
在 prod-cognit 上为 `chat.ai-cognit.com` 签 Let's Encrypt 证书,放到 `/etc/letsencrypt/live/chat.ai-cognit.com/`。

### 前置:确认 webroot 目录存在
```bash
ssh prod-cognit 'ls -la /var/www/cert-challenge/ 2>&1'
```
**预期:** 目录存在(批次 1 部署 `cloud.ai-cognit.com` 时建过)。如果不存在:
```bash
ssh prod-cognit 'sudo mkdir -p /var/www/cert-challenge && sudo chown -R www-data:www-data /var/www/cert-challenge'
```

### 签证书
```bash
ssh prod-cognit '
  sudo certbot certonly --webroot \
    -w /var/www/cert-challenge \
    -d chat.ai-cognit.com \
    --email guoxunpan1006@gmail.com \
    --agree-tos --no-eff-email --non-interactive
'
```

**关键约束:** Cloudflare 必须把 HTTP `/.well-known/acme-challenge/*` 路径透传到源站。我们之前给 `cloud.ai-cognit.com` 配过没启用 "Always Use HTTPS",所以这里应该直接成功。

### 验证
```bash
ssh prod-cognit 'sudo ls /etc/letsencrypt/live/chat.ai-cognit.com/'
```
**预期输出:** `cert.pem fullchain.pem privkey.pem chain.pem README`

如果证书签失败,看 troubleshooting 段。

---

## 任务 3 · nginx vhost

### 目标
让 `chat.ai-cognit.com` 服务 `/var/www/chat/` 里的静态文件(web SPA),带 SPA fallback(所有非文件路径回 `index.html`,react-router 接管)。

### 准备 vhost 文件(在你本地 cogni 仓库)
仓库里已经有模板。位置:`docs/deploy/chat.ai-cognit.com.nginx`(批次 3 留下的)。

**如果文件不存在**,创建它:

```bash
mkdir -p docs/deploy
cat > docs/deploy/chat.ai-cognit.com.nginx <<'NGINX_EOF'
server {
  listen 80;
  listen 443 ssl http2;
  server_name chat.ai-cognit.com;

  ssl_certificate     /etc/letsencrypt/live/chat.ai-cognit.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/chat.ai-cognit.com/privkey.pem;
  include /etc/letsencrypt/options-ssl-nginx.conf;
  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

  root /var/www/chat;
  index index.html;

  # ACME http-01 challenge — keep cleartext for cert renewal.
  location /.well-known/acme-challenge/ {
    root /var/www/cert-challenge;
  }

  # SPA fallback: any non-file path serves /index.html so react-router can take over.
  location / {
    try_files $uri $uri/ /index.html;
  }
}
NGINX_EOF
```

### 装到 prod-cognit
```bash
scp docs/deploy/chat.ai-cognit.com.nginx prod-cognit:/tmp/
ssh prod-cognit '
  # nginx vhost (root needs to write to /etc/nginx)
  sudo install -o root -g root -m 644 \
    /tmp/chat.ai-cognit.com.nginx \
    /etc/nginx/sites-enabled/chat.ai-cognit.com
  # web root (www-data needs to read; rsync from发起人 will fill it later)
  sudo mkdir -p /var/www/chat
  sudo chown -R www-data:www-data /var/www/chat
  # 暂时放个占位 index.html,这样 curl -I 不会 404
  echo "<!doctype html><meta charset=utf-8><title>Cogni</title><p>web SPA 即将上线...</p>" \
    | sudo tee /var/www/chat/index.html > /dev/null
  # reload nginx
  sudo nginx -t && sudo systemctl reload nginx
'
```

### 验证
```bash
# HTTPS 通,200 占位页(不是 404,不是 502)
curl -sI https://chat.ai-cognit.com/ | head -3
```

**预期输出:**
```
HTTP/2 200
server: cloudflare
content-type: text/html
```

如果是 `526` / `502` / `404` → 看 troubleshooting。

---

## 任务 4 · Google OAuth redirect URI

### 目标
让 Google 接受 `https://chat.ai-cognit.com/auth/google/callback` 作为 OAuth callback —— 否则 web 端用 Google 登录会被 Google 拒绝。

### 步骤
1. 登录 [Google Cloud Console](https://console.cloud.google.com)
2. 选择 cogni 用的项目(项目名 / ID 跟 prod 的 `GOOGLE_CLIENT_ID` 对应 —— 发起人那边的 `.env` 里 GOOGLE_CLIENT_ID 是 `XXXXXXXX.apps.googleusercontent.com` 这种形式,前缀是项目 ID)
3. 进 "APIs & Services" → "Credentials"
4. 找到现存的 OAuth 2.0 Client ID(应该叫 "cogni desktop" 或 "cogni web client" 之类),点进去
5. 滚到 "Authorized redirect URIs",点 "ADD URI",填入:
   ```
   https://chat.ai-cognit.com/auth/google/callback
   ```
6. **保留**现有的 `https://cloud.ai-cognit.com/auth/google/callback`(给 desktop 用的 cogni:// 重定向链)
7. 点底部 "SAVE"

### 验证
没法直接 curl 验。回报"已加完"即可,发起人会在 T36 验收时实际跑一次 Google 登录确认。

---

## 任务 5 · 冒烟测试

```bash
# 1. DNS 解析存在(CF 边缘 IP)
dig @1.1.1.1 +short chat.ai-cognit.com

# 2. TLS 通 + 200(占位页)
curl -sI https://chat.ai-cognit.com/ | head -3

# 3. cloud 还活着(确认 nginx 改动没干扰别人)
curl -s https://cloud.ai-cognit.com/health

# 4. 证书过期日期(应该 ~89 天后)
ssh prod-cognit 'sudo certbot certificates 2>&1 | grep -A 1 chat.ai-cognit.com'
```

**全 OK 的输出:**
1. 几个 IP
2. `HTTP/2 200` + `server: cloudflare`
3. `{"ok":true}`
4. `Certificate Name: chat.ai-cognit.com` + `Expiry Date: 2026-08-XX`

---

## 完成回报模板

发起人那边要收到这个回报才能开始 T35 部署:

```
✅ SP-2 manual ops done
- DNS:    chat.ai-cognit.com → CF proxied → 107.174.60.18 (源站)
- Cert:   letsencrypt /etc/letsencrypt/live/chat.ai-cognit.com/ 已签, 过期 YYYY-MM-DD
- nginx:  /etc/nginx/sites-enabled/chat.ai-cognit.com 已装 + reload 成功
- GCP:    OAuth Client ID "<name>" 已加 redirect URI https://chat.ai-cognit.com/auth/google/callback
- 冒烟:   curl -sI https://chat.ai-cognit.com/ → 200 ✓
         curl https://cloud.ai-cognit.com/health → {"ok":true} ✓

请接手 T35(rsync web build + 重启 cogni-cloud)+ T36(E2E 验收)。
```

---

## Troubleshooting

### certbot 签证书失败

**症状:** `Failed authorization procedure` / `Connection refused` / `unauthorized`

**根因可能:**
1. **CF 拦了 HTTP challenge** —— 检查 CF zone settings 没启用 "Always Use HTTPS"。`/.well-known/acme-challenge/*` 必须能从 80 端口透传。
2. **没有现成的 80 端口 vhost 服务这个域名** —— certbot webroot 模式需要 nginx 已经在监听 80 + serving `chat.ai-cognit.com` 的 `/var/www/cert-challenge/`。

**修法:** 先**临时**装一个最小 vhost 只服务 ACME:

```bash
ssh prod-cognit '
  sudo tee /etc/nginx/sites-enabled/chat.ai-cognit.com.acme <<EOF
server {
  listen 80;
  server_name chat.ai-cognit.com;
  location /.well-known/acme-challenge/ { root /var/www/cert-challenge; }
  location / { return 503; }
}
EOF
  sudo nginx -t && sudo systemctl reload nginx
'
```

然后重跑 certbot。**签完了** → `sudo rm /etc/nginx/sites-enabled/chat.ai-cognit.com.acme && sudo systemctl reload nginx`,再装任务 3 的真 vhost(它已经包含 `/.well-known/acme-challenge/` 的 location 用于以后续期)。

### nginx 检查通过但 curl 502

**症状:** `curl -I` 返回 502 Bad Gateway

**根因:** vhost 配错(typo)或 nginx 没真的 reload。

**查看:**
```bash
ssh prod-cognit 'sudo nginx -T 2>&1 | grep -A 20 chat.ai-cognit.com'
ssh prod-cognit 'sudo tail -20 /var/log/nginx/error.log'
```

### curl 526(CF 报源站 cert 问题)

**症状:** Cloudflare 返回 `526 Invalid SSL certificate`

**根因:** CF 设置了 SSL mode = "Full (strict)" 但源站证书还没就位,或证书的 `server_name` 跟 host header 对不上。

**查看:** CF dashboard → SSL/TLS → Overview → 模式应该是 "Full" 或 "Full (strict)"。"Full" 不要求 CF 验证源站 cert chain,临时排查时可以降到 "Full" 通过,之后再切回 "Full (strict)"。但更可能是 nginx vhost 写错了 —— 重看任务 3 vhost 配置。

### Google Console 找不到正确的 OAuth client

**症状:** 项目里有多个 OAuth Client ID,不知道改哪个。

**辨认方法:** 找跟 prod-cognit 上 `/opt/cogni/packages/cloud/.env` 里 `GOOGLE_CLIENT_ID` **同 ID** 的那个。可以 ssh 上去看:

```bash
ssh prod-cognit 'sudo grep GOOGLE_CLIENT_ID /opt/cogni/packages/cloud/.env'
```

把那个 client_id 复制到 GCP Console 的搜索框,定位准确。

### prod-cognit ssh 不通

不是这个文档的范围,联系发起人。

---

## 安全提醒

- **不要** 把 `prod-cognit:/opt/cogni/packages/cloud/.env` 的内容贴到任何聊天/工单/文档里 —— 它有 JWT_SECRET / Neon database URL / SMTP 密码 / Google client secret。
- **不要** 改 `cloud.ai-cognit.com` 的 vhost(它正在服务生产 cogni-cloud,改坏了用户都登不上)。这次只动新建的 `chat.ai-cognit.com`。
- **不要** 改 GCP OAuth client 的其它字段(Client ID / Client secret 改了会让所有 desktop 用户失效)。**只**加 redirect URI,不删不动其它。

---

## 完成后

回报发起人。发起人会:
1. 验证你的回报项
2. SSH 进 prod-cognit `git pull` + `pnpm install + build + rsync apps/web/dist/ → /var/www/chat/`
3. `systemctl restart cogni-cloud`(JWT migration 生效,所有现存 desktop session 失效一次)
4. 跑 T36 E2E 验收剧本

预期发起人那边总用时 ~10 分钟。

完结。
