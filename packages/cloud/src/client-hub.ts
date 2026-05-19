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
  // SP-3 project domain subscriptions. Three distinct channels because the
  // UI consumers are distinct: sidebar/project-list (`projectsSubs` keyed by
  // userId), per-project board (`projectSubs` keyed by projectId), and per-
  // task drawer (`taskSubs` keyed by taskId). Each is a Set<clientId>.
  private projectsSubs = new Map<string, Set<string>>(); // userId   -> clientIds
  private projectSubs  = new Map<string, Set<string>>(); // projectId -> clientIds
  private taskSubs     = new Map<string, Set<string>>(); // taskId    -> clientIds

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
    // SP-3: sweep project-domain subscription sets too. Same shape (Set<clientId>),
    // identical "delete + drop empty set" pattern; we keep them as three separate
    // maps rather than one tagged map to keep the broadcast functions O(1).
    for (const [userId, set] of this.projectsSubs) {
      set.delete(clientId);
      if (set.size === 0) this.projectsSubs.delete(userId);
    }
    for (const [projectId, set] of this.projectSubs) {
      set.delete(clientId);
      if (set.size === 0) this.projectSubs.delete(projectId);
    }
    for (const [taskId, set] of this.taskSubs) {
      set.delete(clientId);
      if (set.size === 0) this.taskSubs.delete(taskId);
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

  // ─── SP-3 project domain subscriptions ─────────────────────────────────────
  //
  // Three channels mirror the SP-2 thread subscription pattern but keyed
  // differently to match the UI consumers:
  //
  //   • `subscribeProjects(clientId, userId)` — sidebar/list-page subscribes
  //     once per user; receives `project-event` (kind: created/updated/archived).
  //     Note: we key on userId at subscribe-time (carried in from the WS auth
  //     claims) instead of looking it up on every broadcast — saves a Map
  //     deref + matches the listSubs ergonomics.
  //
  //   • `subscribeProject(clientId, projectId)` — kanban board subscribes
  //     per open project; receives `task-event` (any task in that project)
  //     plus `project-event` (this project's own updates, so board header
  //     reflects rename/policy edits without a refetch).
  //
  //   • `subscribeTask(clientId, taskId)` — task drawer subscribes when
  //     opened; receives `task-event` for that one task. Runner events for
  //     the task's executionThreadId still flow via SP-2's `subscribe-thread`
  //     (the drawer subscribes to both — taskId here, threadId via SP-2).

  subscribeProjects(clientId: string, userId: string): void {
    if (!this.clients.has(clientId)) return;
    let set = this.projectsSubs.get(userId);
    if (!set) { set = new Set(); this.projectsSubs.set(userId, set); }
    set.add(clientId);
  }

  unsubscribeProjects(clientId: string, userId: string): void {
    const set = this.projectsSubs.get(userId);
    if (!set) return;
    set.delete(clientId);
    if (set.size === 0) this.projectsSubs.delete(userId);
  }

  subscribeProject(clientId: string, projectId: string): void {
    if (!this.clients.has(clientId)) return;
    let set = this.projectSubs.get(projectId);
    if (!set) { set = new Set(); this.projectSubs.set(projectId, set); }
    set.add(clientId);
  }

  unsubscribeProject(clientId: string, projectId: string): void {
    const set = this.projectSubs.get(projectId);
    if (!set) return;
    set.delete(clientId);
    if (set.size === 0) this.projectSubs.delete(projectId);
  }

  subscribeTask(clientId: string, taskId: string): void {
    if (!this.clients.has(clientId)) return;
    let set = this.taskSubs.get(taskId);
    if (!set) { set = new Set(); this.taskSubs.set(taskId, set); }
    set.add(clientId);
  }

  unsubscribeTask(clientId: string, taskId: string): void {
    const set = this.taskSubs.get(taskId);
    if (!set) return;
    set.delete(clientId);
    if (set.size === 0) this.taskSubs.delete(taskId);
  }

  /** Fan-out a project-event to every client subscribed to that user's project list. */
  broadcastProjects(userId: string, msg: CloudToClient): void {
    const set = this.projectsSubs.get(userId);
    if (!set) return;
    for (const clientId of set) this.clients.get(clientId)?.send(msg);
  }

  /** Fan-out an event (project-event or task-event) to per-project subscribers. */
  broadcastProject(projectId: string, msg: CloudToClient): void {
    const set = this.projectSubs.get(projectId);
    if (!set) return;
    for (const clientId of set) this.clients.get(clientId)?.send(msg);
  }

  /** Fan-out a task-event to per-task subscribers (drawer open clients). */
  broadcastTask(taskId: string, msg: CloudToClient): void {
    const set = this.taskSubs.get(taskId);
    if (!set) return;
    for (const clientId of set) this.clients.get(clientId)?.send(msg);
  }
}
