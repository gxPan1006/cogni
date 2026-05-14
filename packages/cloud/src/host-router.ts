import type { CloudToHost } from "@cogni/contract";

export interface ConnectedHost {
  hostId: string;
  userId: string;
  send: (msg: CloudToHost) => void;
}

/** In-memory registry of Runner Hosts that currently hold a live WS to this cloud node. */
export class HostRouter {
  private byHost = new Map<string, ConnectedHost>();
  private byUser = new Map<string, string>(); // userId -> hostId (SP-1: one host per user)

  register(host: ConnectedHost): void {
    const existing = this.byUser.get(host.userId);
    if (existing && existing !== host.hostId) this.unregister(existing);
    this.byHost.set(host.hostId, host);
    this.byUser.set(host.userId, host.hostId);
  }

  unregister(hostId: string): void {
    const host = this.byHost.get(hostId);
    if (!host) return;
    this.byHost.delete(hostId);
    if (this.byUser.get(host.userId) === hostId) this.byUser.delete(host.userId);
  }

  getHostForUser(userId: string): ConnectedHost | null {
    const hostId = this.byUser.get(userId);
    return hostId ? this.byHost.get(hostId) ?? null : null;
  }

  dispatch(userId: string, msg: CloudToHost): boolean {
    const host = this.getHostForUser(userId);
    if (!host) return false;
    host.send(msg);
    return true;
  }
}
