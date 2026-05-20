# SP-3 TBD — 真机 dogfood 留下的后续打磨

2026-05-19 第一次完整跑通"创建项目 → 新任务 → orchestrator dispatch → claude 在 worktree 干活 → reviewing → Accept → merge to main"全链路后,记录的待打磨点。**当前主链路可用**,这里全是边缘场景 / 体验提升 / SP-3+1 候选,不阻塞用。

---

## 进展更新(2026-05-20)

下面原始清单的状态:

| 项 | 状态 | commit |
|---|---|---|
| #1 / #1B systemPrompt + FILE_COMMIT_RULES 注入 dispatch | ✅ 做了 | `f9b4577` |
| #2 AskUserQuestion → needs-input | ⛔️ 用户撤销(产品决策:task 自己做合理假设继续,不停下来弹澄清) | `a4545aa` |
| #3a merge/reject/cancel 后删 task branch | ✅ 做了 | `2e0adaa` |
| #3b push 到 remote 开关 | ✅ 做了(5 层 + per-project checkbox) | `333e5a1` |
| #4 launchd 持久化 runner-host | ✅ 做了(KeepAlive 自拉,真机验证) | `3ffd88c` |
| #6 清废弃 host | ✅ 做了(DB soft-remove) | — |
| #5 mergePolicy 改完立即 drain | ⏳ 未做(优先级低,5s 可接受) | — |
| ProjectDomain 输入类型升 contract 层 | ⏳ 未做(SP-3+1) | — |

**真机闭环达成**:claude 真写文件+commit(补了 `--dangerously-skip-permissions`,见 commit `37f62a7`,claude 之前落进 plan-mode)、Accept 实时移列、push 到 remote、branch 清理,全部生产真机端到端验证过。

### 2026-05-20 新发现的待办

**N1. graceful shutdown hang(部署痛点)**
`packages/cloud/src/main.ts` 的 `shutdown()` 调 `server.close(cb)`,但 `server.close` 要等所有连接(含常连的 host WS)关闭才 fire callback → process 不退 → `systemctl restart` 时卡 `deactivating` 直到 systemd 超时 SIGKILL(每次部署多等几十秒,日志难看)。
修法:shutdown 时先主动 `ws.close()` 所有 host/client WS(或 `injectWebSocket` 的 server 加 `closeAllConnections()`),再 `server.close`;或给 `server.close` 包一个 3s 超时强退 `process.exit(0)`。

**N2. 前端实时同步(已修,留教训)**
2026-05-20 修了 3 个前端 bug(详见 integration-log):host count 0/1 不更新(ws-client 没把 host-status/host-meta 发给 listSubs,`1a60680`)、空 projectId 订阅刷屏(`1a60680`)、**subscribe-project/task 参数顺序反了**(Track C 本地 interface `(projectId,clientId)` vs ClientHub 真实 `(clientId,projectId)`,被 `as` cast + `?.` 绕过 TS 检查 → 订阅静默注册到错误 key,`2f91af6`)。
**教训(写计划/扇出时的 checklist)**:跨 track 共享接口**绝不用 `as` cast + optional chaining 桥接** —— 那等于关掉类型检查,运行时参数错位静默失败最难查。要么直接用真实类型(让 TS 强制),要么接口定义放 contract 层单一来源。

---

## 1. Runner 在空 task 描述下不真 commit 文件

**症状**:task 标题只写 "贪吃蛇小游戏"(5 个字)→ claude 跑完后 worktree 里**没有任何新文件 + 没有 commit**,它把代码直接贴在 ChatBlocks 消息里。Accept → merge to main 只产生一个空 merge commit,用户 `cd repoPath && ls` 看不到产物。

**根因**:claude 默认是 plan-mode 行为(写 plan 到 `~/.claude/plans/...`)。task description 不够具体 + 没有 "写到当前目录" 之类的指示时,它选择"贴代码"而不是"动文件"。

**修法**(选一个):
- **A. 在 dispatch frame 的 message 里包一层 system prompt** 强制 "Always Write files to current directory + git add + git commit before reporting done"。改动:`packages/cloud/src/domains/project/orchestrator.ts:tryDispatchTask` 拼 message 时 prepend system 段。
- **B. 项目级 `systemPrompt` 字段已经有了**(`projects.system_prompt`),前端 NewProject / ProjectSettings 已经收集,但 orchestrator dispatch 时**没读这个字段往 message 里塞**。改一处就行。
- **C. Accept 时的 git-merge-to-main 检测空合并**:merge 前 `git diff main task/<ref>` 没差异就 return `ok:false, message:"task produced no changes"`,UI 显示"无变更"让用户决定 Retry / Reject。

推荐:**先做 B**(消费已有字段,改动最小),后续再做 C(双保险)。

---

## 2. `AskUserQuestion` tool call 没接通到 needs-input 状态

**症状**:claude 跑到一半调 `AskUserQuestion(["现代霓虹","像素复古","清爽"])` 询问视觉风格 → 系统瞬间返回 "Answer questions?" 占位 → claude 看到没人答自己接着干。设计期 SP-3 spec § 把 needs-input 状态明确定义为"runner 主动问业务问题,等用户在抽屉里回消息",但**runner event 流里的 `AskUserQuestion` tool call 没触发 cloud 把 task 切到 needs-input**。

**根因**:`ChatDomain.handleHostEvent` 收到 runner event 后只 append 到 events 表,没识别 "这个 event 是个 AskUserQuestion tool-call" → 没调 `ProjectDomain.transitionTask(running→needs-input, { needsInputWhat: <question>})`。

**修法**:
- 在 `packages/cloud/src/domains/chat.ts:handleHostEvent` 加一个 hook:event 是 `type:'tool-call' && name === 'AskUserQuestion'` 时,查这个 thread 关联的 task,如果存在就 transitionTask running→needs-input + 把 questions text 写到 `needs_input_what`。
- 反向:`POST /tasks/:taskId/reply` 现在已经接 `ChatDomain.handleClientSend(... executionThreadId, content)`(transitionTask needs-input→running 部分已经在 `ProjectDomain.replyToTask` 里实现),路径通。

UI 已经在抽屉里渲染了 reply 输入框 + state stepper 高亮 needs-input,后端补这一段就立刻能用。

---

## 3. Accept 后不删 task branch / 不推到 remote

**症状**:Accept 成功 → `main` 多一个 merge commit + `.worktrees/T-x` 被清,但 `task/t-x` 分支留着,**远端不动**(SP-3 完全不做 git push)。用户 `git branch` 看一堆 `task/t-1 task/t-2 task/t-3 …`,生产仓库 / GitHub 上看不到任何 task 落地。

**根因**:spec § 七只设计了 `git-merge-to-main` + `git-worktree-remove`,没有 `git-branch-delete` 也没有 `git-push-to-remote`。

**修法**(两个独立小工作):
- **3a 删 branch**:`git-merge-to-main` host handler 在 merge 成功后多跑一行 `git -C <repo> branch -d <branchName>`。零契约变更,改 1 个文件。
- **3b 推 remote**:
  - `projects` 表加一个 `push_to_remote boolean default false` 字段(drizzle schema + 一次 push)
  - ProjectSettings UI 加一个开关 "Accept 后自动 push 到 origin"
  - 新增 host RPC `git-push-to-remote { repoPath, branchName: "main" }` 包一个 `git push origin main`
  - `merge-gate.evaluateAndApplyMergeGate` auto-merge 路径里 merge 成功后 if(project.pushToRemote) 调这个 RPC

3a 半小时,3b 半天。

---

## 4. Runner-host 是 `nohup` 跑的,Mac 重启就没了

**症状**:目前本地 runner-host 是 `nohup node dist/main.js &`,pid 写在 `/tmp/runner-host.pid`。Mac 重启 / 关机 / 进程崩溃 → 自动消失。Cloud 把 host 标 offline,所有项目的 task dispatch 全阻塞。

**修法**:写一份 `~/Library/LaunchAgents/com.cogni.runner-host.plist` LaunchAgent,设 `KeepAlive: true` 和 `RunAtLoad: true`,`launchctl load` 一次后开机自启 + 崩了自拉。

文档:写到 `packages/runner-host/README.md` "Local setup" 章节 + 提供一个一键脚本 `pnpm --filter @cogni/runner-host install:launchd`。

---

## 5. Project 设置里 `concurrencyLimit` / `mergePolicy` 改了后,orchestrator 立刻读不到

**症状**(还没真复现,理论分析):用户在 ProjectSettings 把 mergePolicy 从 `require-review` 改成 `auto-merge`,save → DB 更新 → 但 orchestrator 在下次 5s tick 才看见(它每 tick `getProject(projectId)` 拉最新)。这其实**没问题**,延迟 5s 内可接受。但 `concurrencyLimit` 改大后,**已经在 queued 的 task 也得等下次 tick 才被 dispatch**,体感卡。

**修法**(可选,优先级低):`updateProject` 路由更新成功后,主动调一次 `orchestrator.tick()` 让队列立刻 drain。但要小心 re-entrancy(orchestrator 已经有 `this.ticking` 互斥)。

---

## 6. 用户当前账户下有 3 个废弃 host 行

**症状**:`hosts` 表里这个 user(`06a58e0b-...`)有 4 个 host:`3e00f40e`/`0958d7a1`/`d5caab41`/(reused) + 之前在 desktop 设置里点 "Add a new computer" 3 次留下的。当前真用的是 `d5caab41`,其它 3 个 status=offline 永不上线 — desktop 设置页里显示一堆死 host 体验糟。

**修法**:登 prod DB 跑一行 `UPDATE hosts SET removed_at=now() WHERE id IN ('3e00f40e-...','0958d7a1-...')` 软删。或者让用户在 UI 上点删除。1 分钟事。

---

## 7. SP-3 真机 dogfood 暴露的 5 个 bug(已修,留作教训)

完整链路第一次跑前,**spec/plan/agent prompts 漏了这 5 个 bug**:

| commit | bug | 根因 |
|---|---|---|
| `6f703f3` | worktreePath 拼字符串漏斜杠 → safety check 拒绝 | 我给 Track B 写的 prompt 字符串就错了,agent 照抄 |
| `203f58b` | createTask 没创 thread → orchestrator 永 skip dispatch | spec 写了 task 需要 executionThreadId 但没明确"createTask 必须先 createThread" |
| `93bdddc` | gitWorktreeCreate 不幂等 → WS 丢 ack 后撞 already-exists | 没把"WS RPC 没有 ack 机制 → handler 必须幂等"写进 host RPC 设计原则 |
| `35e366c` | dispatch frame 没带 workspacePath → runner cwd 错 | SP-1 dispatch schema 没这个字段,SP-3 spec 提了"runner cwd === worktreePath invariant 3"但实现层没串通 |
| `96432e5` | reconcile 没有 running→reviewing 桥 → 完成的 task 卡 running | B 写了 `handleRunnerDoneForTask` 但 ChatDomain 不知道要调它,orchestrator reconcile 也漏了这一桥 |

**教训写进 `docs/integration-log.md` / 写计划时要点 checklist**:
- [ ] 所有 host RPC handler 必须**幂等**(WS 无 ack)
- [ ] 写 prompt 时,所有路径字符串 / glob 表达式自己手算一遍
- [ ] 业务实体上每个外键字段(executionThreadId / worktreePath / hostId)都明确 "谁在什么时候 set"
- [ ] 每个状态转移在 reconcile + 事件驱动两条路径上都要覆盖(任一条挂了另一条兜底)

---

## 优先级建议

1. **#1B**(项目 systemPrompt 注入 dispatch message) — 修后任务才会真 commit 代码,这是用户感知最强的一项
2. **#2**(AskUserQuestion → needs-input) — 真实 task 经常需要澄清,接通后才完整
3. **#4**(LaunchAgent 持久化 runner-host) — 一次性,做完后 Mac 重启不影响使用
4. **#3a**(merge 后删 task branch) — 小工作,体感清爽
5. **#6**(清废弃 host) — 1 分钟事

其余的 #3b / #5 / #7 总结写入计划,SP-3+1 epic 再做。

---

## SP-4 Artifacts 交付方向(2026-05-20 对齐,待落 spec)

产物如何交到 thin client(web/手机)用户手里 —— 文件产生在 host worktree/scratch,客户端不在那台机器。结论:**不靠系统"猜"哪个是交付物**,project 和 chat 用不同机制:

### Project 模块:git diff + 嵌入式文件浏览器(VSCode 式侧栏)
- 项目/task 详情加一个**文件树侧栏**:展开 worktree 文件夹 → 点文件看内容(只读 + 语法高亮);另有 git diff tab 看本 task 改动。
- **把"区分中间/最终产物"的判断交给用户的眼睛** —— 全列在文件树里,用户自己浏览/下载。系统不判断。

### Chat 模块:不做文件管理,产物当"对话附件"
- 模型生成要交付的文件 → 作为**附件消息**出现在对话流(文件名 + 下载/预览),像 IM 发文件。
- 触发:**模型主动**(判断该给用户就发)**或用户主动**("把刚才的脚本发我")。
- 无文件树 / 无交付清单 UI —— chat 就是对话,产物就是对话里的一条附件。

### 技术骨架
- 新增 `read-file` host RPC(读文件内容/bytes);`fs-browse`(已有)给 project 文件树列目录。
- 对象存储:**Cloudflare R2**(egress 免费)。下载/发附件时 host 读文件 → 传 R2 → 临时过期 URL → 客户端拿。
- 两边都**不需要** deliver 圈定机制:判断责任分别落在 project 的用户眼睛 + chat 的"发附件"动作。

### 待 spec 时拍板
- chat 附件 desktop 端是否也统一走"对话附件下载"(而非直接开本地文件)→ 倾向统一,三端一致。
- project 文件浏览器 desktop 要不要额外"在 Finder 打开"原生入口。
- R2 上传时机:task done 即传 vs 点下载惰性传。

---

## SP-4 sidecar 单二进制(2026-05-20 落地 + 待决策)

把 runner-host 编成自包含 bun 单二进制(`bun build --compile`），替换 SP-1
stopgap shell wrapper。`pnpm --filter desktop build:bundle` 产出可分发 .app/DMG。
spec:`docs/superpowers/specs/2026-05-20-runner-host-single-binary-sidecar-design.md`。
真机三项验收全过(二进制连云 / .app 出仓库连云 / app spawn sidecar 经 lsof 确认连云）。

### S1. launchd 与 app-managed 的 double-spawn(✅ 2026-05-20 已拍板:选 A)
本机 launchd agent `com.cogni.runner-host`(commit `3ffd88c`)曾 active,KeepAlive 跑
`node dist/main.js`。**修好 sidecar 前**,app 从 /Applications 起的 stopgap 找不到
dist/main.js → 起不来 → 只有 launchd 一个 daemon,反而无冲突。**修好后**,app 的
`ensure_daemon` 会真拉起 bun daemon → 与 launchd 的 node daemon 抢同一 hostId(双连)。
**决策:用户选 A(只用 app 管)** —— 已 `pnpm --filter @cogni/runner-host uninstall:launchd`
卸掉本机 launchd(bootout + 删 plist)。app-managed 成为唯一模型,daemon.rs 不改。
真机验证:卸 launchd 后开 app → 恰好 1 个 bun daemon(父进程=app)连云。
注:launchd 安装脚本仍保留在 repo(opt-in,非默认路径)。

### S2. Tauri sidecar 未随 app 退出被回收(与注释不符)
`daemon.rs` 注释称 sidecar "tied to app lifetime, does NOT survive app closing"。
实测 `osascript quit` 关 app 后,sidecar 进程孤儿存活(PPID=1)继续连云。需确认正常
quit 路径下 tauri-plugin-shell 是否真会 kill 子进程,否则 app-managed 模型下会残留
孤儿 daemon + 下次启动 double-spawn。

### 本次未做(沿用 spec Out of scope)
Windows/Linux 二进制、launchd→二进制迁移、daemon.rs liveness 加固(PID 复用误判）、
notarization/Developer ID 签名（仅 ad-hoc）。
