# Email Magic Link Login — Design Spec

**Status:** draft → ready for plan
**Author session:** 2026-05-16
**Related:** SP-1 spine spec (2026-05-14-cogni-sp1-spine-design.md), SP-1 ship at commit `d3a8a8a`

## Goal

让 cogni 在 Google OAuth 不可用的网络环境下也能登录,**根本解决** GFW 后用户(包括项目作者本人)dogfood / 真实使用都登不进去的问题。同时保留 Google OAuth 作为更顺畅的备选 — 能用 Google 的用户走 Google,不能的走邮箱。

身份层做正确:**同一邮箱在两种登录方式下登入是同一个 user**,thread / 历史 / 设置全部互通。

## Non-goals (SP-1 范围外)

显式列出**不在本 spec 范围**的事,plan 阶段不要扩展:

- Account linking UI(两个历史 user row 合并)— SP-2 单独 spec
- 改邮箱 / 邮箱拥有权再验证流程 — SP-2
- 邮件视觉模板(HTML、品牌色)— SP-1 用 plain text + 双语,SP-2 美化
- magic token 持久化(进程重启全失效)— SP-1 可接受(token TTL 15 min,重启代价小);SP-2 移 Redis
- HTTPS 网页 fallback(magic link 点开是网页 → 引导打开 Cogni)— 只用 `cogni://`,跟现有 Google OAuth 路径一致

## User Journey

**Alice 在网络不能用 Google 的环境**:

1. 打开 Cogni → Login 页 同时显示:
   ```
   [Email: _________________]
   [发送登录链接]
   
   ────── 或 ──────
   
   [🔗 Google 登录]
   ```
2. 输入 `alice@gmail.com` → 点 **发送登录链接**
3. 桌面进入"已发邮件"态:
   - 文案 `已发送登录链接到 alice@gmail.com,请在邮件中点击「登录 Cogni」`
   - 重发按钮 `60s 后可重发` 倒计时
   - "用其他邮箱" 链接回上一步
4. Alice 切到邮件客户端(Mail.app / Gmail / Spark / Outlook 等)
5. 收到 plain text 邮件:
   ```
   你好,
   
   有人请求用这个邮箱登录 Cogni。点击下面的链接以登录:
   
       cogni://auth?magic=<token>
   
   如果不是你本人,请忽略这封邮件。链接 15 分钟内有效。
   
   ─────────────────
   
   Hi,
   
   Someone requested a Cogni login for this email. Click the link to sign in:
   
       cogni://auth?magic=<token>
   
   If this wasn't you, ignore this email. The link expires in 15 minutes.
   ```
6. Alice 点 `cogni://auth?magic=...` → macOS 路由到 Cogni desktop
7. `useAuth.onOpenUrl` 接到 URL,识别是 `magic` 参数(不是 `token`)→ 桌面拿 magic token POST `/auth/email/callback`
8. cloud 验 magic → findOrCreateUserByEmail → 签 JWT → 返回 `{ token }`
9. 桌面 setToken → 自动进 Welcome 页(✳ Good evening)

**Bob 能用 Google**:同 Login 页点 `[🔗 Google 登录]`,走现有 OAuth 流程不变。

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Desktop (Tauri + React)                                            │
│  ┌──────────────────┐                                               │
│  │ Login.tsx        │                                               │
│  │  [email form]    │── POST /auth/email/send ──┐                  │
│  │  [Google button] │                            │                  │
│  └──────────────────┘                            │                  │
│                                                  │                  │
│  ┌──────────────────┐                            │                  │
│  │ useAuth.ts       │                            │                  │
│  │  onOpenUrl:      │                            │                  │
│  │   cogni://auth?  │                            │                  │
│  │     magic=xxx    │── POST /auth/email/callback│                  │
│  │     token=yyy    │                            │                  │
│  └──────────────────┘                            │                  │
└──────────────────────────────────────────────────┼──────────────────┘
                                                   │
                                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Cloud (Hono on :8787)                                              │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  routes/email.ts                                               │ │
│  │   POST /auth/email/send                                        │ │
│  │     1. validate email format                                   │ │
│  │     2. rate limit (per-email + per-IP)                         │ │
│  │     3. token = randomBytes(32).base64url()                     │ │
│  │     4. pending.set(token, { email, exp: now+15min })           │ │
│  │     5. transport.sendMagicLink({ to, magicUrl })               │ │
│  │     6. return { ok: true }  (always, no enumeration leak)      │ │
│  │                                                                │ │
│  │   POST /auth/email/callback   { magic }                        │ │
│  │     1. pending.get(magic)  → { email } or null                 │ │
│  │     2. delete pending(magic)  (single-use)                     │ │
│  │     3. findOrCreateUserByEmail(email) → user                   │ │
│  │     4. user_identities upsert (user_id, kind='email')          │ │
│  │     5. auth.issueToken(...) → JWT                              │ │
│  │     6. return { token }                                        │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  email/transport.ts                                            │ │
│  │   sendMagicLink({ to, magicUrl, expiresIn })                   │ │
│  │   ResendTransport — fetch https://api.resend.com/emails        │ │
│  │   FakeTransport (test) — pushes into in-memory array           │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  db/users.ts  +  db/identities.ts                              │ │
│  │   findOrCreateUserByEmail(email) → User                        │ │
│  │   upsertIdentity(userId, kind, sub) → void                     │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                                                   ▲
                                                   │ HTTPS
                                                   │
┌──────────────────────────────────────────────────┴──────────────────┐
│  Resend API (https://api.resend.com)                                │
│  POST /emails  { from, to, subject, text }                          │
└─────────────────────────────────────────────────────────────────────┘
```

**Identity model**(关键改动):

```sql
-- 改:users 表
-- 之前:users.oauth_sub UNIQUE NOT NULL,email NOT NULL(不 unique)
-- 之后:users.oauth_sub 移除,email UNIQUE NOT NULL

ALTER TABLE users DROP CONSTRAINT users_oauth_sub_unique;
ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE(email);
ALTER TABLE users DROP COLUMN oauth_sub;

-- 新:user_identities 表
CREATE TABLE user_identities (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind      text NOT NULL,         -- 'google' | 'email' | 'dev'(dev-token 用)
  sub       text NOT NULL,         -- google sub_id / lowercased email / 'manual'
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, sub)
);
CREATE INDEX user_identities_user_id_idx ON user_identities(user_id);
```

**Migration 策略**:迁移老数据(把现有 `users.oauth_sub` 灌进 `user_identities`,删 `oauth_sub` 列)。drizzle-kit push 可以做。SP-1 db 只有 dev 数据,丢了也无所谓 — push 会先建新结构,人工跑一条 SQL 灌老 row 即可,plan 阶段写明确步骤。

## Components

### packages/cloud/src/email/transport.ts(新)

```ts
export interface EmailTransport {
  sendMagicLink(args: { to: string; magicUrl: string; expiresInMinutes: number }): Promise<void>;
}

export class ResendTransport implements EmailTransport {
  constructor(private opts: { apiKey: string; from: string }) {}
  async sendMagicLink(args): Promise<void> {
    // fetch https://api.resend.com/emails with Bearer this.opts.apiKey
    // body: { from: this.opts.from, to: args.to, subject: "登录 Cogni",
    //         text: <双语模板,含 args.magicUrl> }
    // throw on non-2xx — caller logs but still returns {ok:true} to user
  }
}

export class FakeTransport implements EmailTransport {
  public sent: { to: string; magicUrl: string }[] = [];
  async sendMagicLink(args): Promise<void> { this.sent.push(args); }
}
```

测试默认 FakeTransport,生产从 env 选 Resend。

### packages/cloud/src/routes/email.ts(新)

新 routes 模块,挂在 `/auth/email/*`。已有 CORS(server.ts 已挂 `/auth/*`)+ 不走 Bearer middleware(/api/* 才走)。

POST `/auth/email/send` body `{ email: string }`:
- 验 email 格式(用 zod 简单 regex,不引入 email-validator)
- 查 rate limit(in-memory `Map<key, {count, resetAt}>`,key = `ip:${ip}` 和 `email:${email}` 各一份)
- 生成 magic token(`crypto.randomBytes(32).toString('base64url')`,~43 chars)
- 存 `pending.set(token, { email, createdAt: now })`,定期 sweep 过期
- transport.sendMagicLink
- 返回 `{ ok: true }` 无论 email 是否存在用户、是否发送失败(防 enumeration)
- 发送失败时 log warn(运维可看到,用户看不到)

POST `/auth/email/callback` body `{ magic: string }`:
- pending.get → `{ email }` 或 null
- null → 404 `{ error: "expired" }`(链接失效)
- 立刻 `pending.delete(magic)`(一次性)
- `db.findOrCreateUserByEmail(email)` → user
- `db.upsertIdentity(user.id, "email", email.toLowerCase())`
- `auth.issueToken({ userId, tenantId })` → token
- 返回 `{ token }`

### packages/cloud/src/db/users.ts(改)

```ts
// 之前:findOrCreateUser({ oauthSub, email }) — 按 oauthSub upsert
// 之后:findOrCreateUserByEmail(email) — 按 email upsert
//      + upsertIdentity(userId, kind, sub) 单独处理

export async function findOrCreateUserByEmail(
  db: AnyDb, email: string,
): Promise<User> {
  const lowered = email.toLowerCase();
  const existing = await db.query.users.findFirst({
    where: eq(users.email, lowered),
  });
  if (existing) return existing;
  // create new tenant + user atomically (same as before)
  return await db.transaction(async (tx) => {
    const tenant = await tx.insert(tenants).values({}).returning();
    const user = await tx.insert(users)
      .values({ tenantId: tenant[0].id, email: lowered })
      .returning();
    return user[0];
  });
}

export async function upsertIdentity(
  db: AnyDb, userId: string, kind: "google" | "email" | "dev", sub: string,
): Promise<void> {
  await db.insert(userIdentities)
    .values({ userId, kind, sub })
    .onConflictDoNothing();
}
```

### packages/cloud/src/routes/auth.ts(改)

现有 Google callback 改:
```ts
// 之前:findOrCreateUser({ oauthSub: `google|${sub}`, email })
// 之后:findOrCreateUserByEmail(email)
//      + upsertIdentity(user.id, "google", sub)
```

Dev-token endpoint 同改:
```ts
// 之前:findOrCreateUser({ oauthSub: "dev|manual", email: "dev-manual@local.test" })
// 之后:findOrCreateUserByEmail("dev-manual@local.test")
//      + upsertIdentity(user.id, "dev", "manual")
```

### apps/desktop/src/Login.tsx(改)

新加内部 state machine:
```ts
type LoginState =
  | { kind: "form" }
  | { kind: "sending" }
  | { kind: "sent"; email: string; resendCooldownAt: number }
  | { kind: "error"; reason: "network" | "rate-limit" | "invalid-email" };
```

UI:
- `form` 态:邮箱输入 + 按钮 + 分隔线 + Google 按钮
- `sending` 态:按钮变 loading,禁用其他交互
- `sent` 态:文案 "已发送登录链接到 {email}",按钮 "60s 后可重发"(每秒减一),底部小字 "用其他邮箱?" 链接回 `form`
- `error` 态:在 form 上方红字提示,**留住用户的 email 输入**

### apps/desktop/src/useAuth.ts(改)

`onOpenUrl` 在收到 `cogni://auth?xxx` 时区分两种 query:
- `?token=...`(已有 Google OAuth + dev fallback 走的路径) → 现有逻辑直接 setToken
- `?magic=...`(magic link 新路径) → POST `/auth/email/callback { magic }` → setToken

### packages/cloud/src/main.ts + server.ts(改)

`createServer(deps)` 的 `deps` 加 `emailTransport: EmailTransport` 字段。`main.ts` 从 env 装配:
- `EMAIL_TRANSPORT=resend` + `RESEND_API_KEY=...` + `EMAIL_FROM=Cogni <login@cogni.example>` → ResendTransport
- 没配 → 默认 ConsoleTransport(打印到 stdout,dev 用,生产严禁 — 同 mint-dev-token 那样守卫)

### packages/cloud/.env.example(改)

新增:
```
# Email transport for magic-link login.
# `resend` for production; omit / use `console` for dev (writes the link to
# stdout instead of sending a real email).
EMAIL_TRANSPORT=console
RESEND_API_KEY=
EMAIL_FROM=Cogni <login@cogni.example>
```

## API Contract

### POST /auth/email/send
- Request: `{ email: string }`
- Response: `{ ok: true }` (always 200 on valid input shape — anti-enumeration)
- Errors: 400 if body shape invalid; 429 if rate limited (this one CAN leak per-IP throttling, that's fine)
- CORS: 同 /auth/dev-token,放行 tauri://localhost + http://localhost:1420

### POST /auth/email/callback
- Request: `{ magic: string }`
- Response success: `{ token: string }`
- Response failure: `{ error: "expired" | "invalid" }` with 400
- CORS: 同上

### `cogni://auth?magic=<token>` deep link
- 跟现有 `cogni://auth?token=<jwt>` 共用 scheme,query 参数不同表示路径不同
- useAuth.onOpenUrl 统一处理:
  - `token=` 直接 setToken(Google OAuth 走 cloud server-side 完成 callback 后,把 JWT 直接打在 redirect URL)
  - `magic=` 桌面端 POST callback 自己拿 JWT

## Security

| 维度 | 设计 | Why |
|---|---|---|
| Magic token | 32 byte random,base64url | 不可预测,长度足够 |
| Token TTL | 15 分钟 | 业界惯例(Slack/Linear/Notion 都 15-30 min) |
| 一次性 | callback 成功立刻 delete pending entry | 防止链接被复用 |
| 同 email rate limit | 1/min + 5/hour | 防止邮件轰炸某邮箱 |
| 同 IP rate limit | 3/min + 20/hour | 防止脚本枚举 email |
| Enumeration 防御 | /send 总返回 ok:true,无论 email 是否注册过 | 防泄露用户列表 |
| Pending 存储 | 进程内存 Map,sweep 每 5 min 删过期 | SP-1 单节点 OK;SP-2 多节点用 Redis |
| Token transport | URL query param,经 cogni:// deep-link | 不走 HTTPS body 是因为浏览器/邮件客户端只能 GET URL |
| HTTPS only?| `EMAIL_FROM` domain 必须 SPF/DKIM 配置好(生产) | 防止邮件被标 spam |
| Token in URL → logs? | cogni:// scheme 不会进 nginx / cloud HTTP access log;email magic 单次性 + 15min TTL,即使日志泄露也低危 | 接受残余风险 |

## Email Service Selection

**Recommended for SP-1: Resend**

- 免费 tier 3,000 邮件/月 — dogfood + 早期用户足够
- REST API(HTTPS),不需要 SMTP / Postfix
- API key 一行配置
- 送达率好(用 AWS SES 底层,域名 verify 后 Gmail 不进 spam)
- 文档清晰,SDK 简洁
- 创始团队是 React Email 那班人,DX 友好

**Fallback / 评估 plan 阶段考虑**:
- Postmark — 老牌可靠,免费 100/月稍少
- AWS SES — 最便宜,但 verify 麻烦、deliverability 默认低,需要自己 warm
- 自建 SMTP — 不推荐,deliverability 噩梦

**transport abstraction 是为了 swap 顺手** — 接口稳,实现可换。SP-1 默认 Resend,任何时候可以换。

## Testing Strategy

- `packages/cloud/src/routes/email.test.ts`:
  - 1 个 ChatDomain-style 集成测试用 FakeTransport,覆盖完整 send + callback 流程
  - 4 个 unit 测试:expired token、reused token、enumeration 防御(/send 总 ok)、rate limit 返 429
- `packages/cloud/src/email/transport.test.ts`:
  - ResendTransport 用 fetch mock 断言 POST body 含 magicUrl + bearer auth
  - FakeTransport 累加 sent 数组
- `packages/cloud/src/db/users.test.ts`(改):
  - findOrCreateUserByEmail 两次同 email 返回同 user
  - upsertIdentity idempotent(同 kind+sub 重复调不报错)
- `apps/desktop` 不引入 React 测试栈(SP-1 没有);UI 逻辑通过 dogfood + manual checklist 验证

## Verification (manual after implementation)

人工 dogfood checklist(加进 RUNNING.md):

1. Login 页同时有邮箱输入 + Google 两个 CTA
2. 输入合法 email → "已发邮件"页;输入非法 email → 红字"邮箱格式不对"
3. EMAIL_TRANSPORT=console 时,cloud stdout 打印 magic URL
4. 复制 URL `open <magic-url>` → 桌面接到 → Welcome 页
5. 同一 magic URL 再 `open` 一次 → 桌面提示 "链接已失效"(不能复用)
6. 15 min 后过期(可调短)
7. 短时间连发 5 次 → 第 6 次显示 rate limit
8. 同一邮箱在 Google 登录过的,改走 magic link → Recents 历史还在
9. 桌面 dev-token fallback 路径仍 work(NODE_ENV != production 时 /auth/dev-token 端点仍存在)

## Migration Plan(放进 plan,这里只列要点)

1. drizzle schema 改 users + 新 user_identities
2. 写 migration SQL 灌老 user.oauth_sub 进 user_identities(SP-1 dev db 可以 drop & recreate,但生产要小心)
3. drizzle-kit push
4. 删 `findOrCreateUser` 老签名 → `findOrCreateUserByEmail` + `upsertIdentity` 两个新 fn
5. Google callback 改成新签名
6. dev-token endpoint 改成新签名
7. mint-dev-token.ts 改成新签名

## Open Questions(留待 plan 阶段或 implementer 决策)

- **Email 模板 from 域名怎么定?** — 推 cogni.app 或类似,要先注册 + verify(Resend 要求)
- **Resend region 选 us-east-1 还是 eu-west-1?** — 影响中国到 Resend API 的延迟。eu 通常更通畅。verify 阶段定。
- **桌面"已发邮件"页是否需要轮询 cloud 看"已点击"状态?** — 当前设计纯 deep-link 触发,不轮询。如果 deep-link 接不到,用户唯一信号是手动重试。SP-1 接受。
- **rate limit 触发时桌面文案?** — 暂定 "请稍后再试(1 分钟内只能发 1 次)"。文案 plan 阶段定。

## Dependencies(plan 阶段引入)

- 无需新 npm 包(`crypto.randomBytes` Node 自带、Resend 用 `fetch` 调 API、zod 已有)
- 唯一外部依赖:Resend 账号 + API key + verify 1 个发件域名(用户操作,15 min 内可完成)

## Out of Scope Recap

再强调一遍 SP-1 **不做**:account linking UI、改邮箱流程、HTML 邮件模板、HTTPS 网页 fallback、多节点 token 持久化、邮件多语模板编辑器。这些 SP-2 / 后续。
