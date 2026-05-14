import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHostConfig, writeHostConfig, threadScratchDir, configPath } from "./config.js";

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
