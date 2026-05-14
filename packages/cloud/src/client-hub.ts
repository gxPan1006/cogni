import type { CloudToClient } from "@cogni/contract";

export interface ConnectedClient {
  clientId: string;
  userId: string;
  send: (msg: CloudToClient) => void;
}

/** In-memory registry of UI clients + their thread subscriptions, for fan-out. */
export class ClientHub {
  private clients = new Map<string, ConnectedClient>();
  private subs = new Map<string, Set<string>>(); // threadId -> clientIds

  register(client: ConnectedClient): void {
    this.clients.set(client.clientId, client);
  }

  unregister(clientId: string): void {
    this.clients.delete(clientId);
    for (const [threadId, set] of this.subs) {
      set.delete(clientId);
      if (set.size === 0) this.subs.delete(threadId);
    }
  }

  subscribe(clientId: string, threadId: string): void {
    if (!this.clients.has(clientId)) return; // ignore subscriptions from unknown clients
    let set = this.subs.get(threadId);
    if (!set) { set = new Set(); this.subs.set(threadId, set); }
    set.add(clientId);
  }

  broadcast(threadId: string, msg: CloudToClient): void {
    const set = this.subs.get(threadId);
    if (!set) return;
    for (const clientId of set) this.clients.get(clientId)?.send(msg);
  }

  sendToUser(userId: string, msg: CloudToClient): void {
    for (const c of this.clients.values()) if (c.userId === userId) c.send(msg);
  }
}
