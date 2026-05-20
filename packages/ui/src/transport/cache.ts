/**
 * ClientCache — a tiny per-ApiClient, in-memory stale-while-revalidate store.
 *
 * Why this exists: every data hook (useThreadStream, useProjectBoard,
 * useTaskDetail, useProjects) used to hold its payload in plain `useState` and
 * re-fetch from scratch on every id change. Switching to a thread/project you
 * already viewed blanked the view for the duration of the HTTP round-trip — the
 * visible "flash". This cache lets a hook seed its state SYNCHRONOUSLY from the
 * last-seen payload (instant, flash-free) while it revalidates in the
 * background. WebSocket deltas keep the cached entry fresh so a switch-back
 * shows live state, not a stale snapshot.
 *
 * Deliberately dumb: no TTL, no eviction, no persistence. The dataset (one
 * user's threads/projects) is small and the cache lives only as long as the
 * ApiClient (i.e. the session). Keys are namespaced by the caller, e.g.
 * `thread:<id>`, `project:<id>`, `project-tasks:<id>`, `task:<id>`, `projects`.
 */
export class ClientCache {
  private store = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.store.set(key, value);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  delete(key: string): void {
    this.store.delete(key);
  }
}
