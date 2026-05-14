import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

export interface HostConfig {
  hostId: string;
  registrationToken: string;
  cloudUrl: string; // e.g. ws://localhost:8787
}

export function configDir(): string {
  return process.env.COGNI_HOME ?? join(homedir(), ".cogni");
}
export function configPath(): string {
  return join(configDir(), "host.json");
}

export async function readHostConfig(): Promise<HostConfig | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath(), "utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>).hostId === "string" &&
      typeof (parsed as Record<string, unknown>).registrationToken === "string" &&
      typeof (parsed as Record<string, unknown>).cloudUrl === "string"
    ) {
      return parsed as HostConfig;
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeHostConfig(cfg: HostConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(cfg, null, 2), "utf8");
}

/** Per-thread working directory the Claude Code adapter runs in. */
export function threadScratchDir(threadId: string): string {
  return join(configDir(), "threads", threadId);
}
