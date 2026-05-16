/**
 * Sliding-window rate limiter. Keeps a list of hit timestamps per key, prunes
 * anything outside the largest window on each check, and asserts each bucket's
 * `max` is not exceeded. Used for `/auth/email/send`: pass two buckets
 * (per-minute and per-hour) so brief bursts and sustained abuse are both
 * blocked.
 *
 * In-memory and per-process — fine for SP-1 single-node cloud, replaced by a
 * shared store (Redis) when SP-2 introduces multi-node.
 */
export interface Bucket { windowMs: number; max: number; }

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private buckets: Bucket[]) {
    if (buckets.length === 0) throw new Error("RateLimiter needs at least one bucket");
  }

  /** Record a hit for `key`. Returns `false` if any bucket would be exceeded. */
  check(key: string): boolean {
    const now = Date.now();
    const longestWindow = this.buckets.reduce((m, b) => Math.max(m, b.windowMs), 0);
    const cutoff = now - longestWindow;

    const all = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    for (const b of this.buckets) {
      const windowStart = now - b.windowMs;
      const inWindow = all.filter((t) => t > windowStart).length;
      if (inWindow >= b.max) {
        this.hits.set(key, all); // still record the pruned list to avoid memory growth
        return false;
      }
    }

    all.push(now);
    this.hits.set(key, all);
    return true;
  }

  /** Test seam — clears all buckets. */
  reset(): void { this.hits.clear(); }
}
