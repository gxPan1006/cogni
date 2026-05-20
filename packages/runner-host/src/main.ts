import { readHostConfig } from "./config.js";
import { RunnerManager } from "./runner-manager.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
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
    }),
  );
  logger.info({ hostId: config.hostId }, "runner host daemon started");
}
