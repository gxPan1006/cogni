/**
 * mock — placeholder data for screens that aren't wired to the API yet
 * (Settings hosts/devices, Project tasks, Artifacts).
 *
 * Delete this file as you wire each section up. The shapes are intentionally
 * close to what `@cogni/contract` will expose so swapping is mechanical.
 */

export type DesignHost = {
  id: string;
  name: string;
  status: "online" | "offline";
  lastSeen: string;
  adapters: string[];
};

export const MOCK_HOSTS: DesignHost[] = [
  { id: "h-home", name: "Home MacBook Pro", status: "online",  lastSeen: "now",    adapters: ["claude-code"] },
  { id: "h-work", name: "Work MacBook Air", status: "online",  lastSeen: "3m ago", adapters: ["claude-code"] },
  { id: "h-mini", name: "Studio Mac mini",  status: "offline", lastSeen: "2h ago", adapters: ["claude-code"] },
];

export type DesignDevice = {
  id: string;
  kind: "desktop" | "web" | "phone";
  name: string;
  where: string;
  when: string;
  current: boolean;
  ip: string;
};

export const MOCK_DEVICES: DesignDevice[] = [
  { id: "d-mac",    kind: "desktop", name: "Desktop App",     where: "MacBook Pro · here", when: "just now",  current: true,  ip: "—" },
  { id: "d-mini",   kind: "desktop", name: "Desktop App",     where: "Studio Mac mini",     when: "2h ago",    current: false, ip: "198.51.100.7" },
  { id: "d-chrome", kind: "web",     name: "Chrome on macOS", where: "Work iMac",           when: "5m ago",    current: false, ip: "203.0.113.42" },
  { id: "d-ios",    kind: "web",     name: "Safari",          where: "iPhone 15 · LTE",     when: "yesterday", current: false, ip: "203.0.113.88" },
];

export type DesignTask = {
  id: string;
  ref: string;
  title: string;
  state: "queued" | "running" | "needs-input" | "reviewing" | "done" | "failed";
  hostId: string | null;
  elapsed: string;
  progress: number;
  retries: number;
  activity: string;
  delta: string;
};

export const MOCK_TASKS: DesignTask[] = [
  { id: "T-101", ref: "COG-118", title: "Fix dispatcher race when host reconnects mid-stream", state: "running",     hostId: "h-home", elapsed: "4m 12s",  progress: 0.62, retries: 0, activity: "Editing host-router.ts",      delta: "+87 −34" },
  { id: "T-102", ref: "COG-121", title: "Add events.seq backfill migration",                  state: "running",     hostId: "h-work", elapsed: "12m 04s", progress: 0.41, retries: 1, activity: "Running pnpm test --filter cloud", delta: "+22 −8" },
  { id: "T-103", ref: "COG-117", title: "Drop unused user_identities.email_normalized column", state: "reviewing",   hostId: "h-home", elapsed: "8m 33s",  progress: 1.0,  retries: 0, activity: "Awaiting review",              delta: "+4 −18" },
  { id: "T-104", ref: "COG-124", title: "Sketch the multi-host fallback inline card",         state: "queued",      hostId: null,     elapsed: "—",       progress: 0,    retries: 0, activity: "Waiting for a free runner",    delta: "—" },
  { id: "T-105", ref: "COG-119", title: "Magic link emails landing in spam — investigate DKIM", state: "needs-input", hostId: "h-work", elapsed: "23m 18s", progress: 0.72, retries: 2, activity: "Permission: read /etc/postfix", delta: "0 0" },
  { id: "T-106", ref: "COG-115", title: "Move client-hub off in-memory Map to Redis pub/sub", state: "failed",      hostId: "h-mini", elapsed: "17m 02s", progress: 0.55, retries: 3, activity: "Errored: no redis instance",   delta: "+162 −41" },
  { id: "T-107", ref: "COG-112", title: "Wire up Tauri deep-link for email magic callback",   state: "done",        hostId: "h-home", elapsed: "6m 19s",  progress: 1.0,  retries: 0, activity: "Merged to main",               delta: "+44 −12" },
];

export const STATE_COLOR: Record<DesignTask["state"], string> = {
  queued:        "var(--muted)",
  running:       "var(--accent)",
  "needs-input": "var(--warn)",
  reviewing:     "oklch(60% 0.10 270)",
  done:          "var(--good)",
  failed:        "var(--bad)",
};

export const STATE_LABEL: Record<DesignTask["state"], string> = {
  queued:        "Queued",
  running:       "Running",
  "needs-input": "Needs input",
  reviewing:     "Review",
  done:          "Done",
  failed:        "Failed",
};
