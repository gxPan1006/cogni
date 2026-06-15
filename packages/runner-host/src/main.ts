import {
  readHostConfig,
  setProjectsRoot,
  setKeepAwake,
  setDefaultAdapter,
  resolveKeepAwake,
  resolveClaudeSnapshotKernel,
} from "./config.js";
import { RunnerManager } from "./runner-manager.js";
import { ClaudeCodeAdapter, makeClaudeProcessFactory } from "./adapters/claude-code.js";
import { CodexAdapter } from "./adapters/codex/index.js";
import { connectToCloud } from "./registry.js";
import { dispatchHostRpc } from "./rpc-dispatcher.js";
import {
  gitInitIfMissing,
  gitWorktreeCreate,
  gitWorktreeRemove,
  gitMergeToMain,
  gitPushToRemote,
  gitTestsRun,
  gitDiffSnapshot,
} from "./git-ops.js";
import { fsBrowse, readFile } from "./fs-browse.js";
import { generateThreadTitle } from "./generate-title.js";
import { UploadStore } from "./uploads.js";
import { startKeepAwake, stopKeepAwake } from "./keep-awake.js";
import { logger } from "@cogni/shared";

// SP-4: `mcp-serve` subcommand runs the cogni stdio MCP server instead of the
// daemon. The Claude Code orchestrator runner spawns this same binary with
// `mcp-serve` (works for `node dist/main.js mcp-serve` and the compiled
// sidecar alike). The stdio transport keeps the process alive; no daemon.
if (process.argv.includes("mcp-serve")) {
  const { startCogniMcpServer } = await import("./mcp/cogni-tools.js");
  try {
    await startCogniMcpServer();
  } catch (err) {
    logger.error({ err: String(err) }, "cogni mcp-serve failed to start");
    process.exit(1);
  }
} else {
  const config = await readHostConfig();
  if (!config) {
    logger.error("no ~/.cogni/host.json — register this host from the desktop app first");
    process.exit(1);
  }

  const manager = new RunnerManager();
  manager.register(new ClaudeCodeAdapter());
  const snapshot = resolveClaudeSnapshotKernel(config.claudeKernel);
  if (snapshot.kernel) {
    logger.info(
      { command: snapshot.kernel.command, args: snapshot.kernel.args, locked: snapshot.locked },
      "claude snapshot kernel resolved",
    );
    manager.register(new ClaudeCodeAdapter(makeClaudeProcessFactory(snapshot.kernel), "claude-code-snapshot"));
  }
  // SP-3: second adapter — see adapters/codex/index.ts for the capability
  // asymmetry with claude-code (no session-resume, no permission-prompt).
  manager.register(new CodexAdapter());

  const uploads = new UploadStore();

  // SP-3: wire the host-RPC dispatcher. The cloud uses this to delegate
  // git-ops + fs-browse to the host (which owns the user's local disk).
  connectToCloud(config, manager, (req) =>
    dispatchHostRpc(req, {
      gitInitIfMissing,
      gitWorktreeCreate,
      gitWorktreeRemove,
      gitMergeToMain,
      gitPushToRemote,
      gitTestsRun,
      gitDiffSnapshot,
      fsBrowse,
      readFile,
      generateThreadTitle,
      uploadBegin: (r) => uploads.begin(r),
      uploadChunk: (r) => uploads.chunk(r),
      uploadCommit: (r) => uploads.commit(r),
      uploadAbort: (r) => uploads.abort(r),
      setProjectsRoot: (req) => setProjectsRoot(req.projectsRoot),
      // Persist the flag, then apply it live so the toggle takes effect without
      // a daemon restart.
      setKeepAwake: async (req) => {
        const res = await setKeepAwake(req.enabled);
        if (res.enabled) startKeepAwake();
        else stopKeepAwake();
        return res;
      },
      setDefaultAdapter: (req) => setDefaultAdapter(req.defaultAdapter),
    }),
  );
  logger.info({ hostId: config.hostId }, "runner host daemon started");

  // Keep this machine awake while the daemon runs, so remote clients can always
  // reach the host. On by default; user can toggle it off from Settings or pin
  // it via COGNI_KEEP_AWAKE. Released on shutdown (and caffeinate -w
  // self-terminates if we crash).
  if (resolveKeepAwake(config.keepAwake).enabled) startKeepAwake();

  // Kill any warm `claude` processes on shutdown so they don't outlive the
  // daemon as orphans.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down — closing runner sessions");
    stopKeepAwake();
    void manager.closeAll().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
