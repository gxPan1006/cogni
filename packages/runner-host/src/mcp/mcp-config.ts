import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config.js";

/**
 * SP-4: the cogni orchestrator tool surface. Each name maps to one cloud REST
 * call in `cogni-tools.ts`; the human-equivalent project/task mutations the
 * Workspace Chat orchestrator can perform.
 */
export const COGNI_TOOL_NAMES = [
  "list_projects",
  "list_tasks",
  "create_task",
  "cancel_task",
  "delete_task",
  "accept_task",
  "reject_task",
  "retry_task",
  "reply_task",
  "create_project",
  "rename_project",
  "delete_project",
] as const;

/** MCP tool ids as Claude Code sees them (server name `cogni` → `mcp__cogni__<tool>`). */
export const COGNI_ALLOWED_TOOLS = COGNI_TOOL_NAMES.map((n) => `mcp__cogni__${n}`);

/**
 * Launch command for the cogni MCP server = this same binary with `mcp-serve`.
 * Works for both startup shapes:
 *  - `node dist/main.js`  → execPath=node, argv[1]=script path → `[script, "mcp-serve"]`
 *  - compiled sidecar     → execPath=binary, no JS argv[1]     → `["mcp-serve"]`
 */
export function cogniMcpServerCommand(): { command: string; args: string[] } {
  const script = process.argv[1];
  // A `.js`/`.ts`/`.mjs`/`.cjs` argv[1] means we are running under node; pass
  // the script back so the child re-enters main.js. A compiled sidecar has no
  // JS entry script in argv[1], so just hand it the subcommand.
  const isNodeScript = typeof script === "string" && /\.(c|m)?[jt]s$/.test(script);
  const args = isNodeScript ? [script, "mcp-serve"] : ["mcp-serve"];
  return { command: process.execPath, args };
}

/** Write `~/.cogni/cogni-mcp.json` describing the cogni stdio MCP server; returns its path. */
export function ensureCogniMcpConfig(): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "cogni-mcp.json");
  const { command, args } = cogniMcpServerCommand();
  writeFileSync(path, JSON.stringify({ mcpServers: { cogni: { command, args } } }, null, 2));
  return path;
}
