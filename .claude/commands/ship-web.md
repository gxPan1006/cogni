---
name: ship-web
description: 只把网页端全量更新到线上去手测 —— 提交+推送当前改动，按需部署 prod 云端/web SPA + 跑待处理迁移，核验网页端跑在最新代码上。**不打包、不重装桌面 app**（那是 /ship 的活）。触发词：ship-web、只发网页、网页上线、发个网页版去测、推代码部署但不打 app、web 部署、只更新线上 web。当用户想"改完推上去、只在网页端快速验证、别动桌面 app"时用它。
argument-hint: <可选：commit message；或 no-deploy / with-tests 等范围提示>
allowed-tools: Read Grep Glob Bash Edit Write TaskCreate TaskUpdate TaskList
---

# /ship-web — 只把网页端更新到最新，交付手测

把"我改完了"变成"**网页端（chat.ai-cognit.com）在最新代码上、可以开始手测了**"。
一条龙：**提交 → 推送 → 按需部署云/web + 迁移 → 核验网页端**。

**和 /ship 的区别：这个命令绝不碰桌面 app**（不 bump 版本、不编 sidecar 二进制、不 tauri build、
不退旧装新）。要三端拉齐（含 app）用 `/ship`。

本轮意图 / 范围提示：`$ARGUMENTS`（空就按默认走）。

> 这个项目是 **ai-cognit**（新项目），不是旧 cognit。服务器主机名 cognit/pre-cognit/prod-cognit
> 只是历史命名。部署目标是 `prod-cognit`（`/opt/cogni`，systemd `cogni-cloud`，SPA 在 `/var/www/chat`）。
> 权威部署 runbook 在 `docs/DEPLOYMENT.md` —— 命令以它为准，本文若与它冲突先信它。

把下面每个阶段建成 TodoWrite 任务，按序执行。**核心纪律：报告结果不报告过程，每一步自己验证再往下走。**

---

## 阶段 0 — 摸清现状（先看边界再动手）

```sh
git rev-parse --abbrev-ref HEAD                 # 当前分支
git status --short                              # 哪些改动（区分"我的" vs 别的 agent 留下的）
git log --oneline -5
ssh -o ConnectTimeout=10 prod-cognit 'cd /opt/cogni && sudo -u cogni git rev-parse --short HEAD'   # 记为 $PROD
```

判断：
- **哪些改动是本轮要发的**？工作树常有别的并行 agent 留下的无关改动。只 `git add` 本轮相关文件，
  **绝不 `git add -A`**。拿不准逐个文件确认。未跟踪的个人文件（如根目录 `CLAUDE.md`）也别带上。
- 项目惯例直接推 `main`。若在 feature 分支且用户没特别说，先确认要不要 merge 进 main 再发
  —— prod 是 `git pull` main 的，发别的分支它拉不到。

---

## 阶段 1 — 构建闸门（发之前先证明能编过）

```sh
pnpm build && pnpm typecheck
```

- 编不过就**停下来修**，别硬发。这是给手测省时间的最便宜保险。
- 测试默认不跑（慢）；范围提示里写了 `with-tests` 才 `pnpm test`。

---

## 阶段 2 — 提交 + 推送

```sh
git add <本轮相关文件>                            # 精确添加，不要 -A
git commit -m "<message>"                         # $ARGUMENTS 给了就用，否则按改动归纳
git push origin <branch>
```

提交规范（来自全局 CLAUDE.md）：
- 同步往项目根 `changelog/YYYYMMDD_HHMMSS.md` 写一条（Summary + Changes 分组）。`changelog/` 已
  gitignore，是本地记录，**不要 `git add` 它**。
- commit message 结尾加：
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

推送前若 `git status` 显示 `behind`，先 `git fetch` 看 origin 多了什么：
- 同内容重复提交 → `git rebase --empty=drop origin/main` 丢空提交再 ff。
- 推送必须 fast-forward；非 ff 别强推，先搞清分叉。
- 若本轮改动**已经提交并推送过**（HEAD == origin/main），跳过本阶段，直接进部署。

---

## 阶段 3 — 部署 prod（**按需**，不无脑重启）

先 diff prod 当前 commit（阶段 0 的 `$PROD`）到新 HEAD，判断改了哪些层：

```sh
git diff --stat $PROD HEAD -- packages/cloud packages/contract packages/shared apps/web
```

### 3a. 同步 prod checkout + **编译 dist**（永远做，零风险）

> ⚠️ 关键教训（2026-05-20 踩过）：prod cloud 跑的是 `node dist/main.js`，**不是 tsx 跑 src**。
> `git pull + pnpm install` 不会重编 `dist/`，光 `systemctl restart` 只是把**旧 dist 重启一遍**
> —— 新路由/新逻辑根本没上线（表现：新 API 打到 cloud.ai-cognit.com 返 404/异常，前端静默失败
> 像"点了没反应"）。所以 cloud/contract/shared 有改动**必须先 build 再 restart**。

```sh
ssh prod-cognit 'sudo -u cogni bash -c "cd /opt/cogni && git pull --ff-only && pnpm install --frozen-lockfile && pnpm -r --filter \"@cogni/*\" build"'
```

验证 dist 真的新了（用本次新增的符号 grep dist，对得上才算编进去）：

```sh
# 例：本次加了 /api/me 路由
ssh prod-cognit 'grep -rc "/api/me" /opt/cogni/packages/cloud/dist/routes/profile.js'   # 期望 >0
```

### 3b. 跑待处理的 DB migration（**重启前**，关键！）

新代码若依赖新列/新表，**必须在重启云服务前**先迁移，否则服务起来就崩。migration 幂等，重跑安全。

```sh
git diff --name-only $PROD HEAD -- packages/cloud/src/scripts/        # 看本次新增/改了哪些 migrate-*.ts
# 对每个新的逐个跑：
ssh prod-cognit 'sudo -u cogni bash -c "cd /opt/cogni/packages/cloud && pnpm exec tsx --env-file=.env src/scripts/migrate-YYYY-MM-DD-NAME.ts"'
```

拿不准就把 2026 当月的几个幂等 migration 都跑一遍（幂等，安全）。

### 3c. 重启云服务（**仅当 cloud/contract/shared 有 diff**）

```sh
ssh prod-cognit 'sudo systemctl restart cogni-cloud && sleep 2 && sudo systemctl status cogni-cloud --no-pager | head -10'
```

- 普通重启**不会**踢登录态（只有轮换 `JWT_SECRET` 才会让所有 JWT 失效）。
- 重启可能因 graceful-shutdown hang 卡几十秒到 systemd 超时 SIGKILL —— 已知现象（见 `tbd.md` N1），别慌。
- 若阶段 3 diff 里 cloud/contract/shared 为空 → **跳过重启**，明确告诉用户"云端无代码变化，未重启"。

### 3d. 发布 web SPA（**仅当 apps/web 有 diff**）

```sh
ssh prod-cognit 'sudo -u cogni bash -c "cd /opt/cogni && pnpm --filter web build" \
  && sudo rsync -a --delete /opt/cogni/apps/web/dist/ /var/www/chat/ \
  && sudo chown -R www-data:www-data /var/www/chat'
```

- 若 `apps/web` 无 diff（纯后端改动）→ 跳过，告诉用户"网页静态资源无变化，只更新了云端"。

---

## 阶段 4 — 核验网页端在最新（交付前必做）

别只说"发完了"，拿证据。注意 MEMORY.md 的 stale-process 陷阱。
**API 在 cloud.ai-cognit.com，不是 chat.ai-cognit.com**（后者是 SPA 静态站，未匹配 GET 兜底回
index.html 给 200、POST 给 405 —— 拿它探活会误判，必须打 cloud.* 才准）。

```sh
# 1. 云服务活着
ssh prod-cognit 'sudo systemctl is-active cogni-cloud'             # active

# 2. 本次新增的 API 路由真上线了（无 token 期望 401=已注册要鉴权，而非 404=没这路由）
curl -s -o /dev/null -w "%{http_code}\n" https://cloud.ai-cognit.com/api/me   # 期望 401（非 404）

# 3. SPA 是新构建（仅当 3d 发过 web）：对比线上资产 hash 和本地刚 build 的
curl -sI https://chat.ai-cognit.com | head -1                     # 200
curl -s https://chat.ai-cognit.com | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'   # 线上 hash
ls apps/web/dist/assets/index-*.js                                # 本地 hash，一致才算 web 真更新
```

**commit 一致**：local HEAD == origin/main == prod HEAD。

---

## 收尾汇报（给手测用户）

一句话说清"现在该测什么、在哪测、是不是最新"，聚焦**网页端**，按"表现 + 行为"讲：
- **网页端**（chat.ai-cognit.com）：在 prod 哪个 commit、本次有/无云端变化、有/无 SPA 变化、
  需不需要重新登录（普通部署不需要）、要刷新浏览器拿新前端。
- 本次新功能在网页端怎么测：用户点哪 → 看到什么 → 然后怎样（具体到按钮/交互）。
- 列出实际改了什么、跳过了什么（如"云端无变化未重启"），别让用户对着没变的东西瞎测。
- **明确提醒**：本命令没动桌面 app，`/Applications/Cogni.app` 还是旧的；要在 app 端测请用 `/ship`。

---

## 默认与范围提示（$ARGUMENTS）

- 无参数：全量走（构建闸门 → 提交推送 → 按需部署云/web+迁移 → 核验网页端）。
- 一段普通文字：当 commit message 用。
- `no-deploy`：只提交推送 + 本地构建，不 ssh prod。
- `with-tests`：阶段 1 额外 `pnpm test`。
- `force-restart`：阶段 3c 即便 diff 为空也重启云服务（极少用）。

**永远不做**：版本号 bump、桌面 app 构建/重装、sidecar 二进制编译 —— 那些是 `/ship` 阶段 4 的活，
本命令明确不碰。
