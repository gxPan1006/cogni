import type { CloudToHost } from "@cogni/contract";

export interface ConnectedHost {
  hostId: string;
  userId: string;
  send: (msg: CloudToHost) => void;
}

/** In-memory registry of Runner Hosts that currently hold a live WS to this cloud node. */
export class HostRouter {
  private byHost = new Map<string, ConnectedHost>();
  private byUser = new Map<string, Set<string>>(); // userId -> Set<hostId>

  register(host: ConnectedHost): void {
    // Same hostId re-registering = previous socket replaced.
    this.byHost.set(host.hostId, host);
    let set = this.byUser.get(host.userId);
    if (!set) {
      set = new Set();
      this.byUser.set(host.userId, set);
    }
    set.add(host.hostId);
  }

  unregister(hostId: string): void {
    const host = this.byHost.get(hostId);
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
