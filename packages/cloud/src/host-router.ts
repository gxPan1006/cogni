import type { CloudToHost, RunnerCommandId } from "@cogni/contract";

export interface ConnectedHost {
  hostId: string;
  userId: string;
  send: (msg: CloudToHost) => void;
  /**
   * Per-adapter composer commands the host advertised on `register` (keyed by
   * adapter id). Absent for old hosts. The chat domain reads this to tell a
   * client which "/" commands a thread's adapter supports.
   */
  adapterCommands?: Record<string, RunnerCommandId[]>;
}

/** In-memory registry of Runner Hosts that currently hold a live WS to this cloud node. */
export class HostRouter {
  private byHost = new Map<string, ConnectedHost>();
  private byUser = new Map<string, Set<string>>(); // userId -> Set<hostId>
  // Wall-clock (ms) of the last frame received from each host. Refreshed by
  // `touch` on every inbound frame; consulted by `getStaleEntries` so the
  // host-ws reaper can evict hosts that went silent (e.g. laptop slept and the
  // TCP socket half-opened without ever firing `close`).
  private lastSeen = new Map<string, number>();

  register(host: ConnectedHost, now: number = Date.now()): void {
    // Same hostId re-registering = previous socket replaced.
    this.byHost.set(host.hostId, host);
    this.lastSeen.set(host.hostId, now);
    let set = this.byUser.get(host.userId);
    if (!set) {
      set = new Set();
      this.byUser.set(host.userId, set);
    }
    set.add(host.hostId);
  }

  /** Refresh a host's liveness clock. No-op for unknown hosts (won't resurrect
   *  one that already unregistered — guards against a late frame racing close). */
  touch(hostId: string, now: number = Date.now()): void {
    if (this.byHost.has(hostId)) this.lastSeen.set(hostId, now);
  }

  /** Hosts whose last frame is older than `thresholdMs`, with their owning user
   *  so the caller can broadcast a per-host offline event. */
  getStaleEntries(thresholdMs: number, now: number = Date.now()): { hostId: string; userId: string }[] {
    const out: { hostId: string; userId: string }[] = [];
    for (const [hostId, seen] of this.lastSeen) {
      if (now - seen <= thresholdMs) continue;
      const host = this.byHost.get(hostId);
      if (host) out.push({ hostId, userId: host.userId });
    }
    return out;
  }

  /** Convenience: just the stale hostIds. */
  getStaleHosts(thresholdMs: number, now: number = Date.now()): string[] {
    return this.getStaleEntries(thresholdMs, now).map((e) => e.hostId);
  }

  unregister(hostId: string): void {
    const host = this.byHost.get(hostId);
    this.lastSeen.delete(hostId);
    if (!host) return;
    this.byHost.delete(hostId);
    const set = this.byUser.get(host.userId);
    if (set) {
      set.delete(hostId);
      if (set.size === 0) this.byUser.delete(host.userId);
    }
  }

  /** SP-1 compat: returns "any" host for the user. Used by code still on the
   *  one-host-per-user model — slated for removal once Task 14 lands. */
  getHostForUser(userId: string): ConnectedHost | null {
    const list = this.getOnlineHostsForUser(userId);
    return list[0] ?? null;
  }

  getOnlineHostsForUser(userId: string): ConnectedHost[] {
    const set = this.byUser.get(userId);
    if (!set) return [];
    return [...set]
      .map((id) => this.byHost.get(id))
      .filter((x): x is ConnectedHost => !!x);
  }

  getHostByIdForUser(userId: string, hostId: string): ConnectedHost | null {
    const set = this.byUser.get(userId);
    if (!set || !set.has(hostId)) return null;
    return this.byHost.get(hostId) ?? null;
  }
}
