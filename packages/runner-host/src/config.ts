import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  DEFAULT_RUNNER_ADAPTER_ID,
  RUNNER_ADAPTER_IDS,
  type RunnerAdapterId,
  type SetDefaultAdapterResponse,
  type SetProjectsRootResponse,
  type SetKeepAwakeResponse,
} from "@cogni/contract";
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
  /** Preferred Agent Loop core for new sessions. Absent => Claude Code. */
  defaultAdapter?: RunnerAdapterId;
  /** Optional custom Claude Code snapshot kernel. When present, the host also
   *  advertises `claude-code-snapshot` as a selectable core. */
  claudeKernel?: ClaudeKernel;
}

/** A spawnable Claude Code-compatible kernel: an executable plus prefix args
 *  that precede the standard stream-json flags. `{ command: "claude", args: [] }`
 *  is the stock global CLI; `{ command: "bun", args: ["run", "<entry>.tsx"] }`
 *  runs a local source checkout/snapshot. */
export interface ClaudeKernel {
  command: string;
  args: string[];
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

/** Resolve the optional Claude Code snapshot kernel: COGNI_CLAUDE_KERNEL env
 *  (locked; whitespace-split into command + prefix args) → host.json
 *  `claudeKernel` → null. The default global CLI is registered separately as
 *  `claude-code`, so this only enables the third `claude-code-snapshot` core. */
export function resolveClaudeSnapshotKernel(
  configValue: ClaudeKernel | undefined,
): { kernel: ClaudeKernel | null; locked: boolean } {
  const env = process.env.COGNI_CLAUDE_KERNEL;
  if (env && env.trim().length > 0) {
    const [command, ...args] = env.trim().split(/\s+/);
    return { kernel: { command: command ?? "claude", args }, locked: true };
  }
  if (configValue && typeof configValue.command === "string" && configValue.command.length > 0) {
    return {
      kernel: { command: configValue.command, args: Array.isArray(configValue.args) ? configValue.args : [] },
      locked: false,
    };
  }
  return { kernel: null, locked: false };
}

/** Persist the keep-awake flag into host.json (no-op + locked when env pins it). */
export async function setKeepAwake(enabled: boolean): Promise<SetKeepAwakeResponse> {
  const resolved = resolveKeepAwake(enabled);
  if (resolved.locked) return { enabled: resolved.enabled, locked: true };
  const cfg = await readHostConfig();
  if (cfg) await writeHostConfig({ ...cfg, keepAwake: enabled });
  return { enabled, locked: false };
}

function isRunnerAdapterId(value: string | undefined): value is RunnerAdapterId {
  return value !== undefined && (RUNNER_ADAPTER_IDS as readonly string[]).includes(value);
}

/** Resolve the host's preferred adapter against what this binary registered. */
export function resolveDefaultAdapter(
  configValue: string | undefined,
  availableAdapters: readonly string[] = RUNNER_ADAPTER_IDS,
): RunnerAdapterId {
  if (isRunnerAdapterId(configValue) && availableAdapters.includes(configValue)) {
    return configValue;
  }
  if (availableAdapters.includes(DEFAULT_RUNNER_ADAPTER_ID)) return DEFAULT_RUNNER_ADAPTER_ID;
  const firstKnown = availableAdapters.find((adapter) => isRunnerAdapterId(adapter));
  return firstKnown ?? DEFAULT_RUNNER_ADAPTER_ID;
}

/** Persist the preferred Agent Loop core into host.json. */
export async function setDefaultAdapter(defaultAdapter: RunnerAdapterId): Promise<SetDefaultAdapterResponse> {
  const cfg = await readHostConfig();
  if (cfg) await writeHostConfig({ ...cfg, defaultAdapter });
  return { defaultAdapter };
}
