import { readHostConfig } from "./config.js";
import { RunnerManager } from "./runner-manager.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { connectToCloud } from "./registry.js";
import { logger } from "@cogni/shared";

const config = await readHostConfig();
if (!config) {
  logger.error("no ~/.cogni/host.json — register this host from the desktop app first");
  process.exit(1);
}

const manager = new RunnerManager();
manager.register(new ClaudeCodeAdapter());
connectToCloud(config, manager);
logger.info({ hostId: config.hostId }, "runner host daemon started");
