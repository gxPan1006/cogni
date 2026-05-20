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
import { fsBrowse } from "./fs-browse.js";
import { generateThreadTitle } from "./generate-title.js";
import { logger } from "@cogni/shared";

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
    generateThreadTitle,
  }),
);
logger.info({ hostId: config.hostId }, "runner host daemon started");
