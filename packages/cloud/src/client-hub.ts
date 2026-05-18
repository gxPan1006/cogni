import type { CloudToClient } from "@cogni/contract";

export interface ConnectedClient {
  clientId: string;
  userId: string;
  send: (msg: CloudToClient) => void;
}

/** In-memory registry of UI clients + their thread / list subscriptions, for fan-out. */
export class ClientHub {
  private clients = new Map<string, ConnectedClient>();
  private subs = new Map<string, Set<string>>(); // threadId -> clientIds
  private listSubs = new Set<string>();          // clientIds subscribed to the list channel

  register(client: ConnectedClient): void {
    this.clients.set(client.clientId, client);
  }

  unregister(clientId: string): void {
    this.clients.delete(clientId);
    this.listSubs.delete(clientId);
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

  unsubscribeThread(clientId: string, threadId: string): void {
    const set = this.subs.get(threadId);
    if (!set) return;
    set.delete(clientId);
    if (set.size === 0) this.subs.delete(threadId);
  }

  subscribeList(clientId: string): void {
    if (!this.clients.has(clientId)) return; // ignore list-subscriptions from unknown clients
    this.listSubs.add(clientId);
  }

  unsubscribeList(clientId: string): void {
    this.listSubs.delete(clientId);
  }

  broadcast(threadId: string, msg: CloudToClient): void {
    const set = this.subs.get(threadId);
    if (!set) return;
    for (const clientId of set) this.clients.get(clientId)?.send(msg);
  }

  sendToUser(userId: string, msg: CloudToClient): void {
    for (const c of this.clients.values()) if (c.userId === userId) c.send(msg);
  }

  /** Single-connection delivery — used by the chat dispatcher for response-only frames
   *  (no-host-online, host-fallback-prompt) that must hit only the sender. */
  sendToConn(clientId: string, msg: CloudToClient): void {
    this.clients.get(clientId)?.send(msg);
  }

  /** Push a host-meta frame to every connection of the host owner. User-level (not list-gated):
   *  host meta is part of the global presence stream, not the thread-list channel. */
  publishHostMeta(userId: string, meta: {
    hostId: string;
    name: string;
    status: "online" | "offline";
    lastSeen: string | null;
  }): void {
    const frame: CloudToClient = { t: "host-meta", hostId: meta.hostId, name: meta.name, status: meta.status, lastSeen: meta.lastSeen };
    this.sendToUser(userId, frame);
  }

  /** Fan-out a thread-meta update (title / lastMsgAt) to that user's list-subscribed clients only. */
  publishThreadMeta(userId: string, meta: { threadId: string; title: string; lastMsgAt: string }): void {
    const frame: CloudToClient = { t: "thread-meta", threadId: meta.threadId, title: meta.title, lastMsgAt: meta.lastMsgAt };
    for (const id of this.listSubs) {
      const c = this.clients.get(id);
      if (c?.userId === userId) c.send(frame);
    }
  }

  /** Fan-out a thread-created event to that user's list-subscribed clients only. */
  publishThreadCreated(userId: string, thread: { id: string; title: string; updatedAt: string }): void {
    const frame: CloudToClient = { t: "thread-created", thread };
    for (const id of this.listSubs) {
      const c = this.clients.get(id);
      if (c?.userId === userId) c.send(frame);
    }
  }

  /** Fan-out a thread-deleted event to that user's list-subscribed clients only. */
  publishThreadDeleted(userId: string, threadId: string): void {
    const frame: CloudToClient = { t: "thread-deleted", threadId };
    for (const id of this.listSubs) {
      const c = this.clients.get(id);
      if (c?.userId === userId) c.send(frame);
    }
  }

  /** User-wide broadcast — alias for sendToUser, named for call-site clarity in chat dispatcher. */
  publishUserBroadcast(userId: string, msg: CloudToClient): void {
    this.sendToUser(userId, msg);
  }
}
