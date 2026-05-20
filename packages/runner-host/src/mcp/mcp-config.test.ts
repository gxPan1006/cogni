import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { COGNI_TOOL_NAMES, COGNI_ALLOWED_TOOLS, ensureCogniMcpConfig } from "./mcp-config.js";

describe("cogni mcp-config", () => {
  it("COGNI_ALLOWED_TOOLS namespaces every tool under mcp__cogni__", () => {
    expect(COGNI_ALLOWED_TOOLS).toContain("mcp__cogni__create_task");
    expect(COGNI_ALLOWED_TOOLS.length).toBe(COGNI_TOOL_NAMES.length);
    for (const t of COGNI_ALLOWED_TOOLS) expect(t.startsWith("mcp__cogni__")).toBe(true);
  });

  it("ensureCogniMcpConfig writes a config pointing at the mcp-serve subcommand", () => {
    const path = ensureCogniMcpConfig();
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    expect(cfg.mcpServers.cogni.args).toContain("mcp-serve");
    expect(typeof cfg.mcpServers.cogni.command).toBe("string");
  });
});
