/**
 * mock — design-time fixtures still used by Settings + a couple of host /
 * device pages until those flows are fully wired to the cloud. SP-3 used to
 * carry `DesignProject` / `MOCK_PROJECTS` / `MOCK_TASKS` / `MOCK_TASK_THREADS`
 * here too; Track E replaced them with `useProjects` / `useProjectBoard` /
 * `useTaskDetail`, so they've been deleted.
 *
 * Keep this file lean: only fixtures with a clear "wired in SP-X" hand-off
 * belong here. Anything else should live in tests, not the source tree.
 */

// ─── Hosts (used by Settings → Hosts in a few mock-driven previews) ────

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

// ─── Devices (Settings → Devices preview) ──────────────────────────────

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
