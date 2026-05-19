# cogni 项目记忆

## 验证前必做：核对运行实例

每次完成"新功能 / bug 修复"且需要用户人肉校验时，**先确认所有相关端跑的都是最新代码、且没有多个实例互相打架**，再让用户去试。否则用户在旧版本/旧进程上看到"没修好"，会绕一大圈才发现是进程问题。

具体检查清单：

1. **列进程**：必须**同时**用两个角度抓，不要只抓工具链：

   ```bash
   # 角度 A：工具链 + bundle
   ps -ef | grep -iE "tauri|cargo|vite|Cogni\.app" | grep -v grep
   # 角度 B：直接抓二进制名（catches orphans 工具链已死、binary 还活着）
   ps -ef | grep -E "target/(debug|release)/desktop|target/(debug|release)/cogni" | grep -v grep
   ```

   - **重点看 PPID=1 的孤儿**：`pnpm tauri dev` 在 cargo 阶段被 Ctrl+C 时，cargo 死了但 spawn 出来的 `target/debug/desktop` 会被 init 接管，变成 PPID=1 的孤儿。这种进程不带 "tauri/cargo/vite" 字样，**角度 A 完全抓不到**。
   - 看是否有多份 `tauri dev` / `vite` 同时在跑
   - 看是否有别的 worktree（`.worktrees/...`）里的 dev server 占着端口
2. **确认 web 端**：本地起的 `pnpm --filter web dev`、或生产 `chat.ai-cognit.com`，搞清楚用户访问的是哪个、对应代码版本是不是我刚改的
3. **确认 desktop 端**：用户启动的是 `pnpm --filter desktop tauri dev`（开发模式，跟随 vite HMR）还是已经 build 出来的 `Cogni.app`（旧产物，必须重新 build）
4. **干净重启原则**：如果发现有混淆的多实例，**先 kill 旧的、再起新的**，避免用户对着旧 webview reload 然后觉得没修好
5. **告诉用户具体怎么验**：哪个窗口、按什么键 reload（Tauri webview Cmd+R）、看哪个表现位

### 为什么

2026-05-18 修"切 session 闪重连"那次：
- 第一轮：改完代码就让用户去试，结果他机器上同时跑着中午 build 的 `Cogni.app`（旧）+ `pnpm tauri dev`（新），他看到的是旧 bundle，反馈"还是有红条"。
- 第二轮：清理时只用 `grep -i "tauri|cargo|vite"` 抓进程，**漏掉了 PPID=1 的 `target/debug/desktop` 孤儿**（之前 Ctrl+C cargo 留下的）。重启 dev 后用户发现有两个 Cogni 窗口。

教训：**孤儿二进制不带工具链字样**，必须额外按二进制名抓一遍。
