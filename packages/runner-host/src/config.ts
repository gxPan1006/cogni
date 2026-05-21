import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { SetProjectsRootResponse, SetKeepAwakeResponse } from "@cogni/contract";
import { expandTilde } from "./paths.js";

export interface HostConfig {
  hostId: string;
  registrationToken: string;
  cloudUrl: string; // e.g. ws://localhost:8787
  /** SP-4: per-host root for auto-created project folders; stored raw (may
   *  contain a leading `~`), expanded on read. Optional for old configs. */
  projectsRoot?: string;
  /** Whether the daemon blocks OS sleep while running. Absent ⇢ default ON
   *  (so old configs keep the machine reachable for remote clients). */
  keepAwake?: boolean;
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

/** Resolve the host's projects-root: COGNI_PROJECTS_ROOT env (locked) →
 *  host.json `projectsRoot` → default `~/cogni`. Always ~-expanded. */
export function resolveProjectsRoot(configValue: string | undefined): { root: string; locked: boolean } {
  const env = process.env.COGNI_PROJECTS_ROOT;
  if (env && env.trim().length > 0) return { root: expandTilde(env.trim()), locked: true };
  return {
    root: expandTilde(configValue && configValue.trim().length > 0 ? configValue.trim() : "~/cogni"),
    locked: false,
  };
}

/** Persist a new projects-root into host.json (no-op + locked when env pins it). */
export async function setProjectsRoot(projectsRoot: string): Promise<SetProjectsRootResponse> {
  const cfg = await readHostConfig();
  const resolved = resolveProjectsRoot(projectsRoot);
  if (resolved.locked) return { projectsRoot: resolved.root, locked: true };
  if (cfg) await writeHostConfig({ ...cfg, projectsRoot });
  return { projectsRoot: resolved.root, locked: false };
}

/** Resolve keep-awake: COGNI_KEEP_AWAKE env (locked, accepts 1/true/yes/on)
 *  → host.json `keepAwake` → default ON. */
export function resolveKeepAwake(configValue: boolean | undefined): { enabled: boolean; locked: boolean } {
  const env = process.env.COGNI_KEEP_AWAKE;
  if (env !== undefined && env.trim().length > 0) {
    const v = env.trim().toLowerCase();
    return { enabled: v === "1" || v === "true" || v === "yes" || v === "on", locked: true };
  }
  return { enabled: configValue ?? true, locked: false };
}

/** Persist the keep-awake flag into host.json (no-op + locked when env pins it). */
export async function setKeepAwake(enabled: boolean): Promise<SetKeepAwakeResponse> {
  const resolved = resolveKeepAwake(enabled);
  if (resolved.locked) return { enabled: resolved.enabled, locked: true };
  const cfg = await readHostConfig();
  if (cfg) await writeHostConfig({ ...cfg, keepAwake: enabled });
  return { enabled, locked: false };
}
