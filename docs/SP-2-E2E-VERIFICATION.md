# SP-2 E2E 验收剧本

> 跑完 T35(部署到 prod)后,按这 9 个剧本逐个验。每个剧本独立、有明确的"通过"标准。失败任一条 → 修后重跑该剧本。
>
> **预计总用时:** 25-40 分钟(顺利)。需要两台 Mac + 一个浏览器(同 email 账号)。
>
> **前置:**
> - Mac A 已装 cogni 桌面 app(目前 dogfood 用的那台,Tauri build 指向 `https://cloud.ai-cognit.com`)
> - 一台 "Mac B":可以是真第二台 Mac,也可以是同台机器跑 `pnpm --filter desktop dev`(用 vite dev 模式,会发 `cogni-app://` 的本地深链 — 临时模拟另一个 host 也行;若不方便就跳过 scenario 5 的 "切到 Mac B" 部分,代替验"无 host" → 重连"有 host" 的 banner 变化)
> - 浏览器(Chrome / Safari)在任意网络可访问 https://chat.ai-cognit.com
> - 同一 email 地址(目前 dogfood 用的)

---

## 0. 预热 — 确认部署没炸

```bash
curl -s https://cloud.ai-cognit.com/health
# 期望:{"ok":true}

curl -sI https://chat.ai-cognit.com/ | head -3
# 期望:HTTP/2 200, content-type: text/html

ssh prod-cognit 'sudo journalctl -u cogni-cloud -n 30 --no-pager | tail -10'
# 期望:看到 "cloud control plane listening" 启动行 + 没有 Error
```

全 OK → 继续。

---

## Scenario 1 — 第二台设备的 account merge

**目的:** 验账号合并(plan §7 `findOrLinkUser` 的 verified-email branch)

**步骤:**
1. Mac B(或 浏览器,任选其一)上**第一次**用 magic-link 登录,**同 email** 跟 Mac A 一致
2. 登录成功后,打开 Mac A 的 cogni app,进设置 → 账户

**通过条件:**
- ✅ Mac B 登录成功,看到了 Mac A 的历史 threads(说明是同一个 user)
- ✅ Mac A 的设置页 "Connected sign-in methods" 列出**两条** identity:Google + Email(同一 email,后者是 Mac B 这次刚加的)
- ✅ Mac A 的设置页 "Logged-in devices" 多了一行(那台 Mac B / 浏览器)
- ✅ 在 cloud DB(可选验证):`ssh prod-cognit 'sudo -u cogni bash -c "cd /opt/cogni/packages/cloud && pnpm exec tsx --env-file=.env -e \"const {neon}=require(\\\"@neondatabase/serverless\\\"); const sql=neon(process.env.DATABASE_URL); sql\\\`SELECT email FROM users\\\`.then(console.log)\""'` 应该**只有一行** user 不是两行

**未通过:** 多个 user 行 = `findOrLinkUser` 没合 → 看 `journalctl -u cogni-cloud` 找 "find-or-link" 相关 warn

---

## Scenario 2 — web 登录 + thread 拉取 + catchup

**目的:** 验 web 登录 + 历史 thread 渲染 + WS 订阅 catchup

**步骤:**
1. 浏览器开 `https://chat.ai-cognit.com`(隐身窗口干净)
2. 用 magic-link 登录(同 email)
3. 登录跳转后,左栏点开一个历史 thread(从 Mac 上以前发过消息的)

**通过条件:**
- ✅ 登录页 → 收到 email → 点链接 → 跳回 `chat.ai-cognit.com/chat`
- ✅ Sidebar 已加载 thread 列表(跟 Mac 上一致)
- ✅ 点开历史 thread → 历史消息全部渲染出来(不卡)
- ✅ 浏览器 DevTools → Network → WS:有一条 `/api/ws?token=...` 长连接,**Frames** 标签里能看到 `subscribe-thread` 出去 + `event` 帧进来 + `catchup-complete` 一条
- ✅ 设置 → Devices 多了一行 "Chrome on macOS"(或类似,看你浏览器)

---

## Scenario 3 — cross-client 实时 fan-out

**目的:** 验同步引擎 — 一端发,其它端即时看到

**步骤:**
1. 同时打开:Mac A 桌面 app(看一个空 thread)+ 浏览器(看**同一个**空 thread)
2. 浏览器输入框打"hi"回车

**通过条件:**
- ✅ 浏览器自己:用户气泡"hi"立刻出现 + 后续 Cogni 回复流式打字渲染
- ✅ Mac A 桌面 app:**同一时刻**(< 500ms 延迟)看到"hi"气泡 + 同样的流式回复
- ✅ DB(可选):`messages` 表里这 thread 只有 1 条 user 消息 + 1 条 assistant 消息(不是重复)

---

## Scenario 4 — host 关机 → 状态 fan-out

**目的:** 验 `publishHostMeta` 在 host disconnect 时正确广播

**步骤:**
1. 在浏览器 + Mac B(或 Sidebar 上显示了 hosts 的端) 都开着设置页 → Runner Hosts
2. **关闭 Mac A 的 cogni app**(完全 quit,不要只关窗口)
3. 等约 30 秒(cogni-cloud 检测断连 + publish 时间)

**通过条件:**
- ✅ 浏览器设置页里 MacBook (Mac A) 的状态指示:🟢 → ⚪(无需手动刷新)
- ✅ Mac B 同样,如果它也开着设置页

**未通过:** 状态没变 → 检查 cogni-cloud 日志有没有 "runner host disconnected" + `publishHostMeta` 触发

---

## Scenario 5 — host fallback prompt + switch

**目的:** 验 multi-host dispatch state machine 的 "preferred offline + alternative online" 分支

**前置:** Mac B 必须真在线(浏览器不算,浏览器不是 runner host)

**步骤:**
1. 上个 scenario 关了 Mac A,现在保持关。开 Mac B(确认它 host 在线)
2. 在浏览器里,打开**最近用过的 thread**(thread 的 preferred host = Mac A,因为它最后跑过)
3. 发新消息"hello again"

**通过条件:**
- ✅ 浏览器对话区出现一个**黄色 inline 卡片**:"⚠️ Home MacBook Pro 不在线 (last seen Xh ago) — 切到 Work MacBook Air?"
- ✅ 卡片里 radio 默认选了 Mac B,点 "切换并发送"
- ✅ 之后:Cogni 回复正常流式回来(运行在 Mac B 上)
- ✅ DB(可选):该 thread 在 `runner_sessions` 表多一行 host_id = Mac B 的,旧那行 status='closed' + closed_at 有值
- ✅ 再发一条消息,**不再出现 fallback 卡片**(preferred 现在是 Mac B)

**未通过:** 没出卡片 → 检查 `host-fallback-prompt` 是否被 cloud 发出,前端是否在 `useThreadStream` 里 setPendingFallback

---

## Scenario 6 — no-host-online banner

**目的:** 验 "全部 host 离线" 的硬阻挡 + 自动 recover

**步骤:**
1. **关 Mac B** 的 cogni app(Mac A 还在关)
2. 浏览器里,在任一 thread 发新消息

**通过条件:**
- ✅ 浏览器对话区出现**红色 banner**:"🔌 没有在线的 cogni 桌面端 — 至少打开一台 Mac 上的 cogni app 才能发消息"
- ✅ Composer 的 Send 按钮置灰(disable)
- ✅ Composer 输入框的文字**保留不清空**

3. **打开** Mac A 的 cogni app(等约 5 秒注册)
- ✅ 浏览器里 banner 自动消失(无需刷新)
- ✅ Composer Send 按钮重新亮起
- ✅ 再点回车 → 消息发出去,Mac A 跑

---

## Scenario 7 — revoke device

**目的:** 验 `auth_sessions.revoked_at` 在 WS 握手时被检查

**步骤:**
1. 浏览器设置 → Devices 列表
2. 找到 "Desktop App"(Mac A) 那行,点"撤销"
3. 切换到 Mac A 桌面 app 窗口

**通过条件:**
- ✅ Mac A 几秒内被弹回登录页(WS 收到 close 4001,清 localStorage)
- ✅ 浏览器设置页 Devices 列表少一行(那个 Mac A 不见了)
- ✅ DB(可选):`SELECT id, device_name, revoked_at FROM auth_sessions WHERE user_id=...` 看到那行 revoked_at 有值
- ✅ Mac A 重新用 magic-link 登录:成功,新 auth_session 行,**旧那行不会复活**

---

## Scenario 8 — WS 断网 reconnect catchup

**目的:** 验 `subscribe-thread + lastSeq` 在重连时正确替补

**步骤:**
1. 浏览器开着一个 thread,Mac A 上对**同一个 thread** 发一条消息让它流起来
2. 流到一半时,浏览器开发者工具 → Network → 改成 "Offline"(Throttling 那个下拉)
3. 等 3 秒
4. Network → 恢复 "No throttling"

**通过条件:**
- ✅ 浏览器 WS 状态:断开 → 几秒后重连(可看 Network 里 WS 的 status)
- ✅ 流式消息恢复继续,**不丢中间任何片段**(消息完整、tool calls 完整)
- ✅ Mac A 那边没任何感觉(本地继续跑)

**未通过:** 中间缺片段 → 看 `lastSeqRef` 在 useThreadStream 是不是正确累加;或者 cloud 的 streamCatchup 触发条件

---

## Scenario 9 — 跨用户越权检查

**目的:** 验 `subscribe-thread` + `GET /api/threads/:id` 的 ownership 拒绝

**步骤:**
1. 浏览器 DevTools → Console,执行(替换 `<not-yours>` 为一个明显不是你的随机 UUID):
```js
const ws = new WebSocket(`wss://cloud.ai-cognit.com/api/ws?token=${localStorage.getItem("cogni_token")}`);
ws.onopen = () => ws.send(JSON.stringify({ t: "subscribe-thread", threadId: "12345678-1234-1234-1234-123456789012" }));
ws.onclose = (e) => console.log("closed", e.code, e.reason);
```

**通过条件:**
- ✅ Console 看到 `closed 4003 forbidden`(WS 被 cloud 拒绝)
- ✅ 同样,curl 验:
```bash
TOKEN=$(在浏览器 console 跑 localStorage.getItem("cogni_token") 拿到)
curl -sI -H "Authorization: Bearer $TOKEN" \
  https://cloud.ai-cognit.com/api/threads/12345678-1234-1234-1234-123456789012
# 期望:HTTP/2 404 (不是 200 不是 403,以免泄漏 thread 存在与否)
```

---

## 完成 → 关闭 SP-2

全 9 个剧本通过:

```bash
# 让我或 git 留个完成标记
cd /Users/guoxunpan/code/cogni
git tag -a sp-2-shipped -m "SP-2 验收通过 — 9/9 dogfood scenarios pass on $(date +%Y-%m-%d)"
git push origin sp-2-shipped
```

然后通知发起人写最后一篇 integration-log 收尾 + 把 plan/spec 标 "done"。

---

## 如有任一剧本失败

把以下复制到 issue / 聊天:
```
失败剧本:Scenario X
观察到的:[实际行为]
期望:[剧本里写的]
journalctl 末 30 行:
[贴]
浏览器 Console 任何 error / WS frames 异常:
[贴]
```
