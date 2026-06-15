import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { mkdtemp, readFile as rf, writeFile as wf } from "node:fs/promises";
import { join } from "node:path";
import {
  readHostConfig,
  writeHostConfig,
  threadScratchDir,
  configPath,
  resolveProjectsRoot,
  setProjectsRoot,
  resolveClaudeSnapshotKernel,
  resolveDefaultAdapter,
  setDefaultAdapter,
} from "./config.js";

beforeEach(() => {
  process.env.COGNI_HOME = mkdtempSync(join(tmpdir(), "cogni-"));
});

describe("host config", () => {
  it("returns null when no config file exists", async () => {
    expect(await readHostConfig()).toBeNull();
  });
  it("writes then reads back a config", async () => {
    const cfg = { hostId: "h1", registrationToken: "tok", cloudUrl: "ws://localhost:8787" };
    await writeHostConfig(cfg);
    expect(await readHostConfig()).toEqual(cfg);
  });
  it("derives a per-thread scratch dir under COGNI_HOME", () => {
    expect(threadScratchDir("t1")).toContain(join("threads", "t1"));
  });
  it("returns null for a config file with broken JSON", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), "{ not valid json", "utf8");
    expect(await readHostConfig()).toBeNull();
  });
  it("returns null for a config missing required fields", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(configPath()), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ hostId: "h1" }), "utf8");
    expect(await readHostConfig()).toBeNull();
  });
});

const ORIG_PROJECTS_ROOT = process.env.COGNI_PROJECTS_ROOT;
const ORIG_CLAUDE_KERNEL = process.env.COGNI_CLAUDE_KERNEL;
afterEach(() => {
  if (ORIG_PROJECTS_ROOT === undefined) delete process.env.COGNI_PROJECTS_ROOT;
  else process.env.COGNI_PROJECTS_ROOT = ORIG_PROJECTS_ROOT;
  if (ORIG_CLAUDE_KERNEL === undefined) delete process.env.COGNI_CLAUDE_KERNEL;
  else process.env.COGNI_CLAUDE_KERNEL = ORIG_CLAUDE_KERNEL;
});

describe("resolveProjectsRoot", () => {
  it("defaults to ~/cogni expanded, unlocked", () => {
    delete process.env.COGNI_PROJECTS_ROOT;
    expect(resolveProjectsRoot(undefined)).toEqual({ root: `${homedir()}/cogni`, locked: false });
  });
  it("uses the config value when no env", () => {
    delete process.env.COGNI_PROJECTS_ROOT;
    expect(resolveProjectsRoot("~/work")).toEqual({ root: `${homedir()}/work`, locked: false });
  });
  it("env wins and locks", () => {
    process.env.COGNI_PROJECTS_ROOT = "~/envroot";
    expect(resolveProjectsRoot("~/work")).toEqual({ root: `${homedir()}/envroot`, locked: true });
  });
});

describe("setProjectsRoot", () => {
  it("writes projectsRoot into host.json and returns expanded path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cogni-cfg-"));
    process.env.COGNI_HOME = dir;
    delete process.env.COGNI_PROJECTS_ROOT;
    await wf(configPath(), JSON.stringify({ hostId: "h", registrationToken: "t", cloudUrl: "ws://x" }), "utf8");
    const res = await setProjectsRoot("~/work");
    expect(res.locked).toBe(false);
    expect(res.projectsRoot).toBe(`${homedir()}/work`);
    const saved = JSON.parse(await rf(configPath(), "utf8"));
    expect(saved.projectsRoot).toBe("~/work"); // stored raw; expanded on read
  });
  it("refuses to write when env-locked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cogni-cfg-"));
    process.env.COGNI_HOME = dir;
    process.env.COGNI_PROJECTS_ROOT = "~/envroot";
    await wf(configPath(), JSON.stringify({ hostId: "h", registrationToken: "t", cloudUrl: "ws://x" }), "utf8");
    const res = await setProjectsRoot("~/work");
    expect(res).toEqual({ projectsRoot: `${homedir()}/envroot`, locked: true });
    const saved = JSON.parse(await rf(configPath(), "utf8"));
    expect(saved.projectsRoot).toBeUndefined();
  });
});

describe("resolveClaudeSnapshotKernel", () => {
  it("is absent by default, so only the global Claude Code core is registered", () => {
    delete process.env.COGNI_CLAUDE_KERNEL;
    expect(resolveClaudeSnapshotKernel(undefined)).toEqual({ kernel: null, locked: false });
  });
  it("uses the structured host.json snapshot value when no env", () => {
    delete process.env.COGNI_CLAUDE_KERNEL;
    expect(resolveClaudeSnapshotKernel({ command: "bun", args: ["run", "/x/cli.tsx"] })).toEqual({
      kernel: { command: "bun", args: ["run", "/x/cli.tsx"] },
      locked: false,
    });
  });
  it("env wins and locks, whitespace-split into command + prefix args", () => {
    process.env.COGNI_CLAUDE_KERNEL = "bun run /Users/me/code/claude-code/src/entrypoints/cli.tsx";
    expect(resolveClaudeSnapshotKernel({ command: "claude", args: [] })).toEqual({
      kernel: { command: "bun", args: ["run", "/Users/me/code/claude-code/src/entrypoints/cli.tsx"] },
      locked: true,
    });
  });
  it("treats a config value with an empty command as absent", () => {
    delete process.env.COGNI_CLAUDE_KERNEL;
    expect(resolveClaudeSnapshotKernel({ command: "", args: [] })).toEqual({ kernel: null, locked: false });
  });
});

describe("resolveDefaultAdapter", () => {
  it("defaults to claude-code", () => {
    expect(resolveDefaultAdapter(undefined, ["claude-code", "claude-code-snapshot", "codex"])).toBe("claude-code");
  });
  it("uses codex when configured and available", () => {
    expect(resolveDefaultAdapter("codex", ["claude-code", "claude-code-snapshot", "codex"])).toBe("codex");
  });
  it("uses the Claude snapshot when configured and available", () => {
    expect(resolveDefaultAdapter("claude-code-snapshot", ["claude-code", "claude-code-snapshot", "codex"])).toBe(
      "claude-code-snapshot",
    );
  });
  it("falls back when configured adapter is unavailable", () => {
    expect(resolveDefaultAdapter("claude-code-snapshot", ["claude-code", "codex"])).toBe("claude-code");
  });
});

describe("setDefaultAdapter", () => {
  it("writes defaultAdapter into host.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cogni-cfg-"));
    process.env.COGNI_HOME = dir;
    await wf(configPath(), JSON.stringify({ hostId: "h", registrationToken: "t", cloudUrl: "ws://x" }), "utf8");
    const res = await setDefaultAdapter("claude-code-snapshot");
    expect(res).toEqual({ defaultAdapter: "claude-code-snapshot" });
    const saved = JSON.parse(await rf(configPath(), "utf8"));
    expect(saved.defaultAdapter).toBe("claude-code-snapshot");
  });
});
