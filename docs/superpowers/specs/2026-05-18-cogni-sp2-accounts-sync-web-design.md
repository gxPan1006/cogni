# Cogni — SP-2「账户 + 多端同步 + Web 瘦客户端」设计文档

> 日期:2026-05-18
> 状态:已通过头脑风暴评审,待评审 spec 后进入实现计划

---

## 一、范围

SP-1 已经把骨架打通(账户 + Neon + Runner 抽象 + 云↔桌面 host),C 阶段加了
email magic-link + `user_identities` 表(已经预留多 identity provider)。SP-2
在这个地基上长四块肉:

| # | 模块 | 目的 |
|---|---|---|
| 1 | **同步引擎** | 同 user 的所有在线客户端(桌面/web/任何端)实时看到一致的 threads/messages/events 流;reconnect 后按 `events.seq` 自动追平 |
| 2 | **Multi-host dispatch** | 用户可能多台机器装 cogni-host;每个 thread 记一个"默认 host",离线时 UI 提示 fallback 到另一台在线 host;切到新 host 后按消息历史在新机器上重建上下文 |
| 3 | **Web 瘦客户端** | 浏览器里跑(`chat.ai-cognit.com`);能看 thread / 发消息 / 看流式回包;运行还是在用户其中一台在线 host;无任何在线 host → banner 提示 |
| 4 | **账户合并 UI + 设备管理 UI** | "设置 → 已连接的登录方式 / 已同步的设备 / Runner Hosts"页面;同 email 不同 provider 登录 → 自动合并到同一 user;能命名设备、看在线状态、远程吊销 session |

### 明确不做(YAGNI)

| 类别 | 不做 | 推到 |
|---|---|---|
| **Auth** | 新加 OAuth provider(Apple / GitHub / Microsoft);邮箱修改 UI;2FA | SP-2+1 / SP-3 |
| **Web 客户端** | 文件上传;PWA / 离线缓存;手机原生 app;键盘快捷键 | SP-3 / SP-4 |
| **Multi-host** | 显式"pin 一个 thread 永远跑在某台机器";跨 host 本地文件状态同步;真排队 + host 上线自动重发离线消息(改成硬阻挡) | SP-3+ |
| **同步引擎** | typing indicator / presence;未读 badge;多节点 fan-out;magic-link `pending` Map 落库 | SP-3 / 运维 |
| **运维** | /healthz endpoint;CI/CD;多节点云端;DB connection pooler 优化 | DAY-2 / SP-2+1 |
| **域** | 项目域、看板、第二 runner adapter;跨域 Recents/artifacts/记忆;主动介入 | SP-3 / SP-4 |
| **桌面** | Windows / Linux;menubar / 全局快捷键;托盘 | SP-4 |

---

## 二、数据模型变化

SP-1/C 的 schema 上**只动两处**。

### A. 改 `runner_sessions`:去掉每 thread 只有一个 session 的限制

```diff
- threadUq: unique("runner_sessions_thread_uq").on(t.threadId),
+ // 一个 thread 现在可以有多个历史 runner_session(每次切到新 host 起一个新的)。
+ closedAt: timestamp("closed_at"),  // 何时被取代 / 显式关闭
```

`RunnerSessionStatus` enum 扩一个值:

```diff
- export type RunnerSessionStatus = "idle" | "running" | "completed" | "failed";
+ export type RunnerSessionStatus = "idle" | "running" | "completed" | "failed" | "closed";
```

**语义:**
- `idle | running` = 当前活跃,这个 thread 的"current session"指向它
- `completed | failed` = 跑完了(自然终结),`closed_at` 为空
- `closed` = 用户切到别的 host 把它显式取代了,`closed_at` 是被取代的时间

**为什么:** SP-1 是"一 thread 一 host 一 session"硬绑定。SP-2 fallback 时,
旧 host 离线 → 用户选"切到 Work Mac" → 新 host 起新 runner session → 老的标
`closed`。同一 thread 在不同时间跑在不同 host 上,需要多行历史。

**"thread 的默认 host"** 不存新列,直接 query: `runner_sessions WHERE thread_id=X
ORDER BY created_at DESC LIMIT 1` 的 host_id。

### B. 加 `auth_sessions` 表:让 session 可吊销 + 撑设备管理 UI

```ts
export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  deviceName: text("device_name").notNull(),    // "Chrome on macOS" / "Desktop App (MacBook Air)"
  userAgent: text("user_agent"),
  ip: text("ip"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  revokedAt: timestamp("revoked_at"),
});
```

JWT 里加 `session_id` claim。**所有 auth 边界都查一次 `auth_sessions`:**

- **WS 握手**(`/api/ws` 升级时):验 JWT 签名 + DB 查 `auth_sessions.revoked_at IS NULL`,
  通过后这条长连接信任到底,不再每条消息查
- **HTTP API**(每次请求):验 JWT 签名 + DB 查 `auth_sessions`,~20ms 开销可接受
  (HTTP 接口本来调用频率低 —— 主要是初始 `GET /threads`、settings 页面操作)

同时每条 HTTP / 每次 WS 握手都更新 `last_seen_at`(批 update,settings 页"last seen"
列就靠这个)。

### 其他保持不变

| SP-1/C 已经够用的 | 备注 |
|---|---|
| `users.email` 唯一 | 账号合并以 email 为合并 key |
| `user_identities` | C 阶段已预留多 identity;SP-2 只改写入逻辑(merge 而非新建 user) |
| `hosts.name` 可编辑 + `lastSeen` | 设备管理 UI 直接用 |
| `events (thread_id, seq)` 唯一 + payload_json | 同步引擎按 seq 追平就靠这俩 |

### 加新列(操作性)

- `hosts.removedAt` (timestamp, nullable):"Remove host" 软删,保留历史 runner_sessions 数据完整

### 推到后续

- `thread_read_cursors` — 未读 badge(SP-3)
- `pending_magic_link_tokens` 落库 — 多节点才需要

---

## 三、工程结构

```
cogni/
├── packages/
│   ├── contract/        (不动)
│   ├── shared/          (可能加几个工具)
│   ├── cloud/           ★ 改
│   │   ├── sync/
│   │   │   └── client-hub.ts    新:userId → Set<ClientConn> + fan-out
│   │   ├── routes/
│   │   │   ├── devices.ts       新:GET /devices, DELETE /devices/:id
│   │   │   ├── identities.ts    新:GET /identities, DELETE /identities/:id
│   │   │   ├── hosts.ts         新:GET /hosts, PATCH /hosts/:id, DELETE
│   │   │   ├── auth/email.ts    改:/send 加 origin 参数,callback 不动
│   │   │   └── auth/google.ts   改:callback 接受 redirect_uri 参数
│   │   ├── auth/
│   │   │   └── find-or-link.ts  新:统一的 OAuth/magic-link 落 user 逻辑
│   │   └── chat/
│   │       └── dispatcher.ts    改:multi-host preferred + fallback 状态机
│   ├── runner-host/     (不动)
│   └── ui/              ★ 新:从 apps/desktop/src/ 提取的共享 React + 数据层
│       ├── components/  Sidebar, ConversationView, Composer, Settings, ...
│       ├── hooks/       useAuth, useThreads, useThreadEvents, useDevices, ...
│       └── transport/   CloudClient — fetch + WS,平台无关
│
└── apps/
    ├── desktop/         ★ 改:壳变薄
    │   └── src/
    │       ├── App.tsx          引 @cogni/ui + 装 Tauri 桥
    │       └── platform/        deep-link callback, 本地 host daemon 管理
    └── web/             ★ 新:Vite SPA
        └── src/
            ├── App.tsx          引 @cogni/ui + 装 web 桥
            └── platform/        react-router, redirect-based auth, no-host banner
```

### 部署拓扑

```
            Cloudflare proxied
                   │
       ┌───────────┴───────────┐
       ▼                       ▼
  cloud.ai-cognit.com    chat.ai-cognit.com
  (API + WS)             (web 瘦客户端静态)
       │                       │
       └─────┬─────────────────┘
             ▼
        prod-cognit
        ├── nginx vhost cloud.ai-cognit.com  → 127.0.0.1:8787 (cogni-cloud Hono)
        └── nginx vhost chat.ai-cognit.com   → 静态文件 /var/www/chat
            ├── /etc/letsencrypt/live/chat.ai-cognit.com/
            └── SPA fallback:所有非静态文件 fallback 到 /index.html(react-router)
```

Web → API 跨域:**CORS + Authorization header**(不用 cookie,避免 SameSite/CSRF
折腾)。Hono CORS 中间件白名单 `chat.ai-cognit.com` + `tauri://localhost`。

### Deploy 流程加 web

`docs/DEPLOYMENT.md` 增 web 部分:

```bash
ssh prod-cognit '
  sudo -u cogni bash -c "
    cd /opt/cogni \
      && git pull --ff-only \
      && pnpm install --frozen-lockfile \
      && pnpm -r --filter \"@cogni/*\" build \
      && pnpm --filter @cogni/web build
  "
  sudo systemctl restart cogni-cloud
  sudo rsync -a --delete /opt/cogni/apps/web/dist/ /var/www/chat/
'
```

---

## 四、同步引擎

核心思想:**`events` 表是真相源,WS 只是"刚刚有新行写进去了"的通知 + 重连时
追平。** 不引新存储,不引消息队列。

### ClientHub(in-memory single-process)

```
packages/cloud/src/sync/client-hub.ts

registry: Map<userId, Set<ClientConn>>
ClientConn { id, userId, sessionId, ws,
             threadSubscriptions: Set<threadId>,
             listSubscribed: bool }

API (内部):
  - register(conn) / unregister(conn)
  - publishEvent(threadId, eventRow)              ← runner host 回流写完 events 后调
  - publishThreadMeta(userId, threadId, meta)     ← 标题改、消息加
  - publishThreadCreated(userId, thread)
  - publishThreadDeleted(userId, threadId)
  - publishDeviceListChanged(userId)              ← revoke 之后
  - publishHostMeta(userId, hostId, meta)         ← rename / status 变化
```

**多节点假设:** ClientHub 是纯内存单进程。横向扩需 Redis pub/sub,SP-2 不做,
但接口设计成可替换。

### WS 协议(在现有 `/api/ws` 上加新消息类型)

**Client → Server:**
```ts
{ type: "subscribe-list" }                          // 关心 sidebar(thread 列表变化)
{ type: "subscribe-thread", threadId, lastSeq? }    // 进对话页 → 追平 + 后续 live
{ type: "unsubscribe-thread", threadId }
{ type: "send-message", threadId, content }         // (SP-1 已有)
{ type: "resolve-fallback",                         // 用户对 host-fallback-prompt 卡片的响应
  pendingMessageId,
  action: "switch" | "cancel",
  targetHostId? }                                   // action=switch 时必填
```

**Server → Client:**
```ts
// 按 subscribe-thread 路由(只有订阅了 threadId 的 conn 收得到)
{ type: "event", threadId, seq, event }             // runner 事件 fan-out
{ type: "catchup-complete", threadId, latestSeq }

// 按 subscribe-list 路由(只有 listSubscribed 的 conn 收得到)
{ type: "thread-meta", threadId, title, lastMsgAt }
{ type: "thread-created", thread }
{ type: "thread-deleted", threadId }

// 用户级广播(不需要 subscribe,所有同 user 的 conn 都收)
{ type: "device-list-changed" }                     // revoke / 新登录后
{ type: "host-meta", hostId, name, status, lastSeen }  // host 上线/下线/rename/remove

// dispatch 响应(回给发起 send-message 的那个 conn)
{ type: "host-fallback-prompt",
  pendingMessageId,
  preferred: { id, name, lastSeenAgo },
  alternatives: [{ id, name, lastSeenAgo }] }
{ type: "no-host-online", pendingMessageId }
```

### 追平时序(关键流)

```
Web 端:                                    Cloud:
  GET /threads → 列表           ─────▶
  WS connect, send subscribe-list ─────▶  ClientHub.register(conn), 标 listSubscribed
  send subscribe-thread {threadId: T, lastSeq: 0}
                                ─────▶  ClientHub: conn 加 T 到 subscriptions
                                          SELECT * FROM events
                                            WHERE thread_id=T AND seq>0 ORDER BY seq
                                          [回放 seq 1..47]
  收到 47 个 event ◀─────  [流式发]
  收到 catchup-complete{latestSeq:47} ◀─

[Mac 的 runner host 回流第 48 个 event 给 cloud]
                                          cloud 写 events 第 48 行 (seq=48)
                                          ClientHub.publishEvent(T, eventRow48)
  收到 event{seq:48} ◀─────  [实时推]    [hub 找所有订阅 T 的 conn:Mac 客户端 + Web]
[Mac 同时也收到 event{seq:48}]
```

### 用户视角(表现 + 行为)

- **场景 A · Mac 在跑,Web 中途加入:** Web 登录,点开 thread T → 历史消息瞬间
  填好(catchup) → 看剩余流式 text-delta 继续往下打。Mac 那边无任何感觉。
- **场景 B · Web 发消息,Mac 旁观:** Web 输入回车 → 自己马上看到用户气泡(乐观渲染),
  同时 Mac 上也"啪"出现这条用户气泡(`thread-meta` + 新 message fan-out)。然后
  runner 在 Mac 上跑起来,两边一起看流式回复。
- **场景 C · Web 网络抖一下:** WS 断 → 客户端记最后 `seq` → 自动重连 → 重新
  `subscribe-thread {lastSeq: <最后>}` → 拿缺的 1-N event → 继续 live。可能眨一下"重连中"。
- **场景 D · 同 user 两 Mac 都在线:** 两 Mac + 一 Web,共三个 conn。某 thread T 的
  fan-out 触达三个 conn。

### 实现细节

- **订阅鉴权:** `subscribe-thread {threadId}` 校验 `threads.user_id === conn.userId`,
  否则关 WS 4003。
- **大量历史追平:** `MAX_CATCHUP=10000`。超了发 `{type:"catchup-too-long"}`,
  客户端去 HTTP 拉最新 messages,然后从最新 seq 开始 live(等于跳过中间)。
- **race / 并发发消息:** Web 和 Mac 同时点回车 → 各自落 `messages` 表(created_at
  排序天然有序)。dispatcher 串行送给 host 的同一 runner session(顺序处理)。V1
  不去重。

---

## 五、Multi-host dispatch

核心:**99% 路径无感(默认 host 在 → 直接送),偏离正常时弹"切换吗"的卡片**。

### 默认 host 算法

```ts
preferred_host(thread):
  latest_session = SELECT * FROM runner_sessions
                   WHERE thread_id = thread.id
                   ORDER BY created_at DESC
                   LIMIT 1
  return latest_session?.host_id   // 没有就是 null(新 thread)
```

### Dispatch 状态机

**先 check host 再写 message** — 避免"写了 message 但没人跑,UI 看到孤立用户气泡"
的尴尬。Pre-dispatch 状态只在客户端 composer 里,关 app 就丢(用户重打)。

```
[user.sendMessage(threadId, content)]   ← 走 WS send-message
        │
        ▼
1. preferred = preferred_host(thread)
        │
        ├── preferred == null  (新 thread)
        │       │
        │       ▼
        │   online = user 名下 status='online' 的 hosts, 按 last_seen DESC
        │       ├── empty   → {type:"no-host-online"}                (分支 B)
        │       └── ≥1      → ✅ 写 messages 行 + auto-pick 第一个,创 runner_session,dispatch
        │
        ├── preferred 在线  → ✅ 写 messages 行 + 复用/新建 runner_session,dispatch  ✓
        │
        └── preferred 离线
                │
                ▼
            other = user 其它 status='online' 的 hosts
                ├── empty   → {type:"no-host-online"}                (分支 B)
                └── ≥1      → {type:"host-fallback-prompt", ...}     (分支 A)
                              ⚠️ 不写 messages,等用户对卡片回应再决定
```

**resolve-fallback 收到时:**
- `action:"switch", targetHostId` → ✅ 写 messages 行 + 在 target host 起新 runner_session + dispatch
- `action:"cancel"` → 什么都不写。客户端自己决定要不要把"待发文本"塞回 composer

**自动重试(可选 V1 实现):** 用户取消后,客户端记 `pendingResend: { threadId, content }`。
监听 `host-meta {status:online}` → 自动重发 `send-message`(等于走一遍正常流程)。
**纯客户端逻辑,无服务端待办队列。**

### 分支 A · "preferred 离线、有替补":fallback 卡片

**用户表现:** 输入框回车 → 输入框清空 + 一个带操作按钮的卡片插在对话流里
(不是顶部 banner,是 **inline card**,把"该决定了"和这条消息绑在同一时间点位置):

```
┌──────────────────────────────────────────────────┐
│ ⚠️  "Home MacBook Pro" 不在线 (last seen 2h ago) │
│                                                  │
│ 切到这台机器跑?                                  │
│   ○ Work MacBook Air  (online · 刚刚活跃)        │
│                                                  │
│ Claude Code 会在新机器上从消息历史重建上下文,    │
│ 之前在 Home 上未保存的文件不会过来。             │
│                                                  │
│  [ 切换并发送 ]    [ 取消(等 Home 上线) ]         │
└──────────────────────────────────────────────────┘
```

**点"切换并发送":**
- 老 runner_session → `status='closed', closed_at=now`
- 新 runner_session 在 Work Mac 起来,`adapter=claude-code`,`runner_session_id=null`(全新 Claude Code session)
- Dispatch pending message → events 流回来 → 卡片被这条消息的回答顶替
- 之后 thread preferred 变成 Work Mac

**点"取消":**
- 卡片留在原地变灰显"已取消";pending message 还在 composer 上方"待发送"位
- 当 Home 上线 → 卡片自动消失,自动 dispatch 那条 pending message(无需用户再点)

### 分支 B · "全部 host 离线":硬阻挡

**用户表现:** composer 上方出现红色 banner:

```
🔌  没有在线的 cogni 桌面端
   至少打开一台 Mac 上的 cogni app 才能发消息。
```

回车不发送(send 按钮置灰)。**输入的字保留在 composer 不清空** — 用户切到
Mac 打开 app → host 上线 → banner 自动消失(通过 `host-meta` 推送)→ 按钮亮 →
再回车一次。

**V1 不做真排队 + 自动重发:** 那要给 messages 加状态机、host 上线时扫待发消息、
处理"web 上排了 5 条 Mac 上线一口气送"。注明 known limitation。

### 切换的连续性(事件流没断)

```
events 表 per-thread monotonic seq
  ┌────────────────────────────────────────────┐
  │ seq  session_id        host    type        │
  │ 1    sess-mac-home-A   Home    user-msg    │
  │ ...                                        │
  │ 47   sess-mac-home-A   Home    done        │
  │ 48   sess-mac-home-A   Home    user-msg    │ ← "Home 离线"前最后这条
  │ 49   sess-mac-work-B   Work    user-msg    │ ← 切换后第一条
  │ 50   sess-mac-work-B   Work    text-delta  │
  └────────────────────────────────────────────┘
```

客户端看到的:对话流不中断,中间插一行"⏤ 切换到 Work MacBook Air ⏤"分隔符
(从 session_id 跳变推断,UI 渲染时识别)。catchup/sync 都没特殊处理,普通 seq replay。

---

## 六、Web 瘦客户端

### 用户视角:第一次打开 chat.ai-cognit.com

```
1. 访问 https://chat.ai-cognit.com → 进登录页
   ┌─────────────────────────────────────┐
   │            Welcome to Cogni         │
   │                                     │
   │   [ Continue with Google ]          │
   │   ──────── or ─────────             │
   │   Email:  [_______________]         │
   │   [ Send magic link ]               │
   └─────────────────────────────────────┘

2a. Google → 重定向到 accounts.google.com →
    回 https://chat.ai-cognit.com/auth/google/callback?code=... →
    web 前端把 code + redirect_uri 转给 cloud /auth/google/callback → 拿 JWT + sessionId →
    存 localStorage → 进主界面

    (cloud 的 /auth/google/callback 端点接受 `redirect_uri` 参数,这样同一端点能服务
     desktop 和 web 两端 — Google token exchange 要求 redirect_uri 跟初始 auth request 一致)

2b. Email → "已发到 you@x.com" 提示 → 用户去 Gmail 点链接
    (链接为 https://chat.ai-cognit.com/auth/email/callback?token=...,因为发起方 origin=web)
    → web 前端把 token 转给 cloud /auth/email/callback → 拿 JWT + sessionId → 进主界面

3. 主界面:左 sidebar、中对话、底 composer(@cogni/ui 来的,跟桌面完全一样)
   首次 connect WS → ClientHub 注册当前 session 为新 conn
   sidebar 走 GET /threads + subscribe-list 拿后续变更
```

### 关键差异(vs desktop)

- OAuth callback 是 **HTTP redirect 回到 chat.ai-cognit.com**,不是 `cogni://`
  deep link。Google Cloud Console 加 `https://chat.ai-cognit.com/auth/google/callback`
  到 Authorized redirect URIs
- **Magic-link 邮件链接按发起方动态生成:** `POST /auth/email/send` 带
  `origin: "web"|"desktop"`,云端记到 pending token 里:
    - origin=web → 链接走 `https://chat.ai-cognit.com/auth/email/callback?token=...`
    - origin=desktop → 链接走 `cogni://auth/email/callback?token=...`
  同账号两端各管各的

### 路由

```
/                      → 按是否有 JWT 重定向到 /chat 或 /login
/login                 → 登录页
/auth/google/callback  → 自动 POST code,拿 JWT 后跳 /chat
/auth/email/callback   → 自动 POST token,拿 JWT 后跳 /chat
/chat                  → 主界面,默认选最新 thread
/chat/:threadId        → 主界面,选中 thread
/settings              → 设置页
```

### Composer / send 跟桌面**完全一致**

走 multi-host dispatch UX(第五节)。Web 用户同样看到 preferred host 在线时无感
发送、preferred 离线时 inline 卡片、全离线时红色 banner。

**Web vs Desktop 的根本不同:Web 没自己的 host。** 桌面 app 装好自动跑 Runner Host
daemon,自己就是个 host。Web 永远是纯客户端,永远依赖某台桌面在线。

### 没有的(明确)

- ❌ 本地 Runner Host(浏览器跑不了 Claude Code 子进程)
- ❌ 文件上传 UI(SP-3/4 加)
- ❌ Tauri deep-link 注册流程(用 URL 路由代替)
- ❌ menubar / 全局快捷键(SP-4)
- ❌ PWA / 离线缓存(就纯网页)

### 兼容目标

- Chrome / Safari 当前版本 + 手机 Safari(响应式布局)
- 不专门做 IE / 老 Firefox / 嵌入式

### CORS + Auth header

```ts
cors({
  origin: (origin) => origin === "https://chat.ai-cognit.com" || origin === "tauri://localhost",
  credentials: false,
  allowMethods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowHeaders: ["Authorization","Content-Type"],
})
```

Web 端调 API:`Authorization: Bearer <JWT>`。WS 握手:query string `?token=<JWT>`
(浏览器 WS 不支持自定义 header)。

---

## 七、设置页(账号合并 + 设备 + Hosts)

桌面 sidebar 底部齿轮 → `/settings`。Web 同样 → react-router 路由 `/settings`。
两端**同一份 React 组件**(@cogni/ui)。

### 页面结构

```
┌──── Settings ─────────────────────────────────────────────┐
│ === Account ===                                           │
│ Email:  you@x.com                                         │
│                                                           │
│ Connected sign-in methods:                                │
│ ┌─────────────────────────────────────────────────────┐   │
│ │ 🔵 Google                                           │   │
│ │    you@gmail.com · linked 2026-04-01                │   │
│ │                              [ Disconnect ]         │   │
│ ├─────────────────────────────────────────────────────┤   │
│ │ ✉️  Email magic link                                │   │
│ │    you@gmail.com · always available                 │   │
│ │                              [ Disconnect ]         │   │
│ └─────────────────────────────────────────────────────┘   │
│ ⚠️  保留至少一种登录方式,否则进不来账号                 │
│                                                           │
│ === Logged-in devices ===                                 │
│ ┌─────────────────────────────────────────────────────┐   │
│ │ 🖥️  Desktop App                       (this device) │   │
│ │     MacBook Air · 刚刚                              │   │
│ │     last IP: 1.2.3.4                                │   │
│ ├─────────────────────────────────────────────────────┤   │
│ │ 🌐 Chrome on macOS                                  │   │
│ │     Work iMac · 5min ago · IP: 5.6.7.8              │   │
│ │                              [ Revoke ]             │   │
│ └─────────────────────────────────────────────────────┘   │
│              [ Revoke all other devices ]                 │
│                                                           │
│ === Runner Hosts ===                                      │
│ ┌─────────────────────────────────────────────────────┐   │
│ │ 🟢 Home MacBook Pro              [ Rename ]         │   │
│ │    online · adapters: claude-code · last seen: now  │   │
│ ├─────────────────────────────────────────────────────┤   │
│ │ ⚪ Work iMac                     [ Rename ]         │   │
│ │    offline · last seen 2h ago                       │   │
│ │                              [ Remove ]             │   │
│ └─────────────────────────────────────────────────────┘   │
│ + 加新 host:在那台机器装 cogni Desktop app,登录就自动注册│
└───────────────────────────────────────────────────────────┘
```

**"Logged-in devices" 和 "Runner Hosts" 是两类东西:** 一台 Mac 装了 cogni 桌面
app 既出现在 Devices(那个 desktop app 是个登录会话),又出现在 Runner Hosts
(那台机器能跑 Claude Code)。Web 浏览器只在 Devices 出现,因为浏览器跑不了 runner。

### 后端 API

```
GET    /identities                列当前 user 的 user_identities
DELETE /identities/:identityId    解绑 identity(挡 last-one)

GET    /devices                   列 auth_sessions where user=me AND revoked_at IS NULL
DELETE /devices/:sessionId        revoke

GET    /hosts                     列 hosts where user=me AND removed_at IS NULL
PATCH  /hosts/:hostId             改 name
DELETE /hosts/:hostId             软删(removed_at=now)
```

### 账号合并的具体逻辑(关键)

任何 OAuth 或 magic-link callback 统一走这个查/建 user 流程:

```ts
async function findOrLinkUser({ kind, sub, email }) {
  // 1. 已有 identity 记录,直接用(主路径)
  const identity = await db.select.from(userIdentities)
                              .where(and(eq(kind), eq(sub)))
  if (identity) return identity.userId;

  // 2. email 已存在 user → 给那个 user 挂新 identity(合并)
  const user = await db.select.from(users)
                          .where(eq(email, normalizeEmail(email)))
  if (user) {
    await db.insert.userIdentities({ userId: user.id, kind, sub });
    return user.id;
  }

  // 3. 全新用户
  const newUser = await db.insert.users({ email: normalizeEmail(email), tenantId: DEFAULT });
  await db.insert.userIdentities({ userId: newUser.id, kind, sub });
  return newUser.id;
}
```

**为什么对:** Google 的 sub 是 stable identity(改 email 也不变);email-magic
的"sub"就是 lowercased email。两边的 email 都验证过(Google 验过、magic-link
用户点过链接),所以"同 email 就是同人"安全。

**Disconnect identity 时:** UI 计数。
`COUNT(identities WHERE user_id = me) <= 1` → 按钮禁用 + tooltip
"这是唯一登录方式,删了你就进不来"。

### Session revoke 怎么落

- 用户点 [Revoke] → `DELETE /devices/:sessionId` → 那行 `auth_sessions.revoked_at = now()`
- 被 revoke 的 device 下次 WS 握手时,云端查 DB 发现 `revoked_at IS NOT NULL` →
  关 WS code 4001 + 返回 401
- 客户端拿到 401 / WS close 4001 → 清 localStorage → 跳登录页
- 主动 revoke "this device" → 同样流程,前端先本地清完再跳登录

### Rename / Remove host

- **Rename:** PATCH `/hosts/:id { name }`,纯 DB 更新。dispatch 卡片 / Runner Hosts
  list 立即看到新名(通过 ClientHub publish `host-meta`)。
- **Remove(软删):** `hosts.removed_at = now()`。host 下次试图重连时
  `validate(registrationToken)` 查到软删 → 拒。用户要加回:在那台机器
  cogni 桌面 app 里"Re-register"按钮(简单实现:用户手工 logout/login)。

### 多端实时同步设置变更

设置页本身也通过 ClientHub 同步:revoke / rename / remove 操作完成 → 给同 user
所有 conn 发 `{type:"device-list-changed"}` 或 `{type:"host-meta", ...}` → 其它打开
设置页的客户端自动重拉对应区块。**`hosts.status` 在线/离线变化也通过 `host-meta`** —— 
比如 Work iMac 上线 → 所有打开设置页的客户端看到 ⚪ 变 🟢 不用刷新。

---

## 八、验收标准

把 SP-2 是否做完通过这个端到端 dogfood 剧本验:

```
0. 准备:你的 MacBook Air 已经装了 cogni 桌面 app(SP-1/C 的状态),登录用的是 Google。
   (假装)你拿到一台朋友的 Mac mini,你想在上面也装 cogni;以及你在公司用浏览器开 cogni。

1. 朋友的 Mac mini 上下载 cogni 桌面 app → 用 magic-link 登录(同 email)
   ✓ 登录成功;不创建新 user(账号合并到原 Google user)
   ✓ Settings 里看到 2 个 sign-in methods(Google + Email)
   ✓ Settings 里看到 2 个 Runner Hosts(MacBook Air 在线 + Mac mini 在线)

2. 公司浏览器开 https://chat.ai-cognit.com → 用 magic-link 登录(同 email)
   ✓ 进主界面,左栏 sidebar 已加载历史 thread(从 SP-1 时积下来的)
   ✓ 任意 thread 点开 → 历史消息瞬间出来(catchup),滚动正确
   ✓ Settings 里 Devices 多一行 "Chrome on macOS"

3. 在 web 端某 thread 发消息 "hi"
   ✓ MacBook Air 桌面 app 同时显示这条新消息(同步引擎)
   ✓ runner 在 MacBook Air 上跑起来(preferred host = 最近用 = Air)
   ✓ web + MacBook Air 两边都看到流式 text 逐字打出
   ✓ Mac mini 桌面 app 也同步看到(只要它打开着,且也订阅这 thread)

4. 关掉 MacBook Air 的 cogni app → 等 30s 让 cloud 标 offline
   ✓ web + Mac mini 上设置页 MacBook Air 状态从 🟢 变 ⚪

5. 在 web 端同一 thread 发新消息 "hello again"
   ✓ Web 上出现 inline fallback 卡片 "Air 不在线,切到 Mac mini 跑?"
   ✓ Mac mini 上对话页同时也看到这张卡片(同步引擎)
   ✓ 点"切换并发送" → 老 runner_session 标 closed,新 runner_session 在 Mac mini 上起
   ✓ 流式回复继续,web + Mac mini 都看到;后续这 thread preferred = Mac mini

6. 关 Mac mini 的 cogni app → 等 30s
   ✓ web 上 Runner Hosts 两个都 ⚪
   ✓ web 端再发消息 → composer 上方出现红色 banner "🔌 没有在线的桌面端"
   ✓ Send 按钮置灰;输入框文字保留;再开任一台 Mac → banner 自动消失 → Send 亮

7. 在 web 设置页点 "Revoke" 桌面 App 那行
   ✓ 桌面 app 那边 WS 立即断,弹回登录页
   ✓ 桌面 app 重登录(magic-link) → 重新出现在 Devices;Runner Hosts 列表里 MacBook Air 重新 🟢
   ✓ 旧 auth_session 标 revoked,新登录是新行

8. WS 断网模拟:web 上 thread 跑着,断网 5s 再回来
   ✓ 客户端记最后 seq,重连后自动 subscribe-thread {lastSeq:X}
   ✓ 看不到任何消息丢失,缺的 events 一次推齐

9. 安全 / 越权:web 端拿别人的 threadId 调 subscribe-thread / GET /messages
   ✓ 403,WS 关 4003,HTTP 403
```

**通过 = SP-2 done.** 失败任一条得修。

### 不验的(放 SP-3 前提下)

- 大规模并发(>10 同时在线用户)
- 单 thread events > 10000 行的 catchup 性能(只验 hard limit 触发 + 兜底刷新提示)
- 跨时区 / DST 边缘
- 浏览器 BFCache 后台冻结恢复(浏览器层处理)

---

## 九、待后续子项目澄清的开放项

- **DKIM/DMARC 升级:** 目前 `p=none`,SP-2 上线后观察一两周改 `p=quarantine` 再
  `p=reject` —— 这不影响 SP-2 实现,纯 ops 节奏。
- **多节点 cloud 化:** 当并发用户超 ~50/节点容量上限时,ClientHub 改 Redis pub/sub
  + magic-link `pending` 落库,SP-2 之后单独子项目。
- **Mobile native:** SP-3+ 看用户反馈再决定优先级(web 在 mobile 浏览器够不够用,
  还是非要装原生)。
- **Account email 修改 UI:** 现在 `users.email` 是合并 key,修改 email 涉及合并
  冲突,暂不开放。
