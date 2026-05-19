# SP-3 TBD — 真机 dogfood 留下的后续打磨

2026-05-19 第一次完整跑通"创建项目 → 新任务 → orchestrator dispatch → claude 在 worktree 干活 → reviewing → Accept → merge to main"全链路后,记录的待打磨点。**当前主链路可用**(`main` @ `96432e5` 部署在 prod),这里全是边缘场景 / 体验提升 / SP-3+1 候选,不阻塞用。

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
