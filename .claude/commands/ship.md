---
name: ship
description: 一键把 ai-cognit 全量更新到最新并交给用户手动测试 —— 提交+推送当前改动，按需部署 prod 云端/web，重建并重装桌面 app，最后核验"网页端 + app 端"都跑在最新代码上。触发词：ship、上线、全量更新、部署一下、更新到最新去测、网页和 app 都更新、push 并部署。当用户想"改完一把梭、三端拉齐去手测"时用它。
argument-hint: <可选：commit message；或 only-app / only-cloud / no-bump 等范围提示>
allowed-tools: Read Grep Glob Bash Edit Write TaskCreate TaskUpdate TaskList
---

# /ship — 全量更新到最新，交付手动测试

把"我改完了"变成"网页端 + app 端都在最新代码上、可以开始手测了"。一条龙：
**提交 → 推送 → 按需部署云/web → 重建装 app → 核验三端拉齐**。

本轮意图 / 范围提示：`$ARGUMENTS`（空就按默认全量走）。

> 这个项目是 **ai-cognit**（新项目），不是旧 cognit。服务器主机名叫 cognit/pre-cognit/prod-cognit
> 只是历史命名，不代表项目归属。部署目标是 `prod-cognit`（`/opt/cogni`，systemd `cogni-cloud`）。
> 权威部署 runbook 在 `docs/DEPLOYMENT.md` —— 命令以它为准，本文若与它冲突先信它。

把下面每个阶段建成 TodoWrite 任务，按序执行。**核心纪律：报告结果不报告过程，每一步自己验证再往下走。**

---

## 阶段 0 — 摸清现状（先看边界再动手）

并行查清楚，别凭印象：

```sh
git rev-parse --abbrev-ref HEAD                 # 当前分支
git status --short                              # 有哪些改动（注意区分"我的" vs 别的 agent 留下的）
git log --oneline -5
ssh -o ConnectTimeout=10 prod-cognit 'cd /opt/cogni && sudo -u cogni git rev-parse --short HEAD'   # prod 现在在哪个 commit
```

判断：
- **哪些改动是本轮要发的**？工作树里可能有别的并行 agent 留下的无关改动（这个 repo 常有）。
  只 `git add` 本轮相关文件，**绝不 `git add -A` 把别人的东西一起带走**。拿不准就逐个文件确认。
- 当前在 `main` 还是 feature 分支？项目惯例是直接推 `main`（近期提交都在 main）。
  若在 feature 分支且用户没特别说，先确认是要 merge 进 main 再发，还是就发这个分支。

---

## 阶段 1 — 构建闸门（发之前先证明能编过）

手测最怕发上去是坏的。先本地证明能编：

```sh
pnpm build && pnpm typecheck
```

- 编不过就**停下来修**，别硬发。这是给"手动测试"省时间的最便宜保险。
- 测试（`pnpm test`）默认不跑（慢）；范围提示里写了 `with-tests` 才跑。

---

## 阶段 2 — 提交 + 推送

```sh
git add <本轮相关文件>                            # 精确添加，不要 -A
git commit -m "<message>"                         # message：$ARGUMENTS 里给了就用，否则按改动归纳
git push origin <branch>
```

提交规范（来自全局 CLAUDE.md）：
- 同步往项目根 `changelog/YYYYMMDD_HHMMSS.md` 写一条（Summary + Changes 分组）。`changelog/` 已 gitignore，是本地记录，**不要 `git add` 它**。
- commit message 结尾加：
  `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

推送前若 `git status` 显示 `behind`，先 `git fetch` 看清 origin 多了什么：
- 若是同内容的重复提交（别的 agent 也提了同一改动），`git rebase --empty=drop origin/main` 会自动丢空提交，再 ff。
- 推送必须是 fast-forward；非 ff 别强推，先搞清分叉。

---

## 阶段 3 — 部署 prod（**按需**，不无脑重启）

关键判断：**这次推送到底改没改云端/web 代码**？很多改动（比如桌面端/runner-host/文档）
对线上服务是 no-op，无脑 `systemctl restart` 只会带来几十秒抖动 + 触发已知的 graceful-shutdown
hang（见 `tbd.md` N1），毫无收益。

先 diff prod 当前 commit（阶段 0 拿到，记为 `$PROD`）到新 HEAD：

```sh
git diff --stat $PROD HEAD -- packages/cloud packages/contract packages/shared apps/web
```

### 3a. 同步 prod checkout（永远做，零风险）

```sh
ssh prod-cognit 'sudo -u cogni bash -c "cd /opt/cogni && git pull --ff-only && pnpm install --frozen-lockfile"'
```

### 3b. 跑待处理的 DB migration（**重启前**，关键！）

新代码若依赖新列/新表，**必须在重启云服务前**先迁移，否则服务起来就崩。migration 都是幂等的，重跑安全。

```sh
ls packages/cloud/src/scripts/migrate-*.ts                      # 看有哪些
# 对本次新引入的（diff $PROD..HEAD 里新增/改动的 migrate-*.ts）逐个跑：
ssh prod-cognit 'sudo -u cogni bash -c "cd /opt/cogni/packages/cloud && pnpm exec tsx --env-file=.env src/scripts/migrate-YYYY-MM-DD-NAME.ts"'
```

判断"哪些是本次新的"：`git diff --name-only $PROD HEAD -- packages/cloud/src/scripts/`。拿不准就把
2026 当月的几个幂等 migration 都跑一遍（幂等，安全）。

### 3c. 重启云服务（**仅当 cloud/contract/shared 有 diff**）

```sh
ssh prod-cognit 'sudo systemctl restart cogni-cloud && sleep 2 && sudo systemctl status cogni-cloud --no-pager | head -10'
```

- 普通重启**不会**踢登录态（只有轮换 `JWT_SECRET` 才会让所有 JWT 失效）。
- 重启可能因 N1 graceful-shutdown hang 卡几十秒到 systemd 超时 SIGKILL —— 属已知现象，别慌。
- 若阶段 3 的 diff 为空 → **跳过重启**，明确告诉用户"云端无代码变化，未重启"。

### 3d. 发布 web SPA（**仅当 apps/web 有 diff**）

```sh
ssh prod-cognit 'sudo -u cogni bash -c "cd /opt/cogni && pnpm --filter web build" \
  && sudo rsync -a --delete /opt/cogni/apps/web/dist/ /var/www/chat/ \
  && sudo chown -R www-data:www-data /var/www/chat'
```

---

## 阶段 4 — 重建并重装桌面 app

桌面端的 sidecar 是 **bun 编译的单二进制**（见 `docs/superpowers/specs/2026-05-20-runner-host-single-binary-sidecar-design.md`）。
打包用 `build:bundle`（它内部：编二进制 → 放进 Tauri sidecar 路径 → `tauri build` → 自动 `git checkout` 恢复 dev wrapper）。

### 4a. 版本号（默认 bump，范围提示 `no-bump` 则跳过）

为了手测时一眼区分新旧构建，默认 bump patch 版本。三处同步改：
`apps/desktop/src-tauri/tauri.conf.json`、`apps/desktop/src-tauri/Cargo.toml`、`apps/desktop/package.json`。
改完一起提交推送（同阶段 2 规范），Cargo.lock 变了也带上。

### 4b. 构建（耗时，后台跑）

```sh
pnpm --filter desktop build:bundle      # 后台跑，等 "Finished 2 bundles" + dev wrapper 恢复
```
产物：`apps/desktop/src-tauri/target/release/bundle/macos/Cogni.app` 和 `.../dmg/Cogni_<version>_aarch64.dmg`。

### 4c. 退旧装新（**小心 sidecar 孤儿**）

已知坑（`tbd.md` S2）：`osascript quit` 关 app 后 sidecar 二进制有时孤儿存活（PPID=1）继续连云，
不杀掉会和新 app 的 daemon 双连抢同一 hostId。所以退出时显式清干净：

```sh
osascript -e 'tell application "Cogni" to quit' 2>/dev/null; sleep 1
pkill -f "Cogni.app/Contents/MacOS/desktop"; pkill -f "Cogni.app/Contents/MacOS/cogni-runner-host"
rm -f ~/.cogni/daemon.pid
# 确认全清干净（含 PPID=1 孤儿）：
ps -ef | grep -iE "Cogni\.app|cogni-runner-host" | grep -v grep || echo clean
# 装新 + 启动：
rm -rf /Applications/Cogni.app && cp -R apps/desktop/src-tauri/target/release/bundle/macos/Cogni.app /Applications/Cogni.app
open /Applications/Cogni.app
```

> daemon 是 **app-managed**（用户已定，2026-05-20 卸掉了 launchd）：app 开着才在线，关了即掉线。
> 若发现 launchd agent `com.cogni.runner-host` 又回来了，说明有人重装了它 → 会和 app double-spawn，
> 提醒用户 `pnpm --filter @cogni/runner-host uninstall:launchd`。

---

## 阶段 5 — 核验三端都在最新（交付前必做）

别只说"发完了"，要拿出证据。注意 MEMORY.md 的 stale-process 陷阱：用户常对着旧进程测。

**app 端**：恰好 1 个 app-managed daemon 且连上云：
```sh
P=$(ps -ef | grep "Cogni.app/Contents/MacOS/cogni-runner-host" | grep -v grep | awk '{print $2}')
ps -ef | grep "cogni-runner-host" | grep -v grep | wc -l           # 期望 1
lsof -nP -p "$P" 2>/dev/null | grep ":443.*ESTABLISHED"            # 期望有一条到 cloud
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" /Applications/Cogni.app/Contents/Info.plist  # 版本对得上
```

**网页端**：prod 服务活着 + SPA 是新构建：
```sh
ssh prod-cognit 'sudo systemctl is-active cogni-cloud'             # active
curl -sI https://chat.ai-cognit.com | head -1                     # 200
curl -s https://chat.ai-cognit.com | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'   # 资产 hash
# 对比本地刚构建的 apps/web/dist 里的 index.*.js hash，一致才算 web 真更新了
```

**三方 commit 一致**：local HEAD == origin/main == prod HEAD。

---

## 收尾汇报（给手测用户）

一句话说清"现在该测什么、在哪测、是不是最新"，按"表现 + 行为"分端讲：
- **网页端**（chat.ai-cognit.com）：在 prod 哪个 commit、本次有/无服务端变化、需不需要重新登录。
- **app 端**（/Applications/Cogni.app）：版本号、host 是否在线、提醒"在 Tauri webview 里按 Cmd+R 刷新看新前端"。
- 列出本次实际改了什么、跳过了什么（如"云端无变化未重启"），别让用户对着没变的东西瞎测。
- DMG 路径附上，方便分发到别的 Mac。

---

## 默认与范围提示（$ARGUMENTS）

- 无参数：全量走（构建闸门 → 提交推送 → 按需部署 → bump+重建装 app → 核验）。
- 一段普通文字：当 commit message 用。
- `only-app`：跳过阶段 3（不碰 prod），只重建装 app。
- `only-cloud` / `only-web`：只做阶段 3，不动 app。
- `no-bump`：阶段 4a 跳过版本号。
- `with-tests`：阶段 1 额外 `pnpm test`。
- `no-deploy`：只提交推送 + 本地构建，不 ssh prod。
