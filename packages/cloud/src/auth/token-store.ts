/**
 * Short-lived token storage for things like magic-link tokens.
 *
 * The interface is fully async because the in-memory implementation is only
 * the SP-2 single-node story. The moment we go horizontal (SP-2+1), the same
 * route code must work against a shared store — Redis being the natural fit:
 * `SET key value EX <ttl-seconds>` for `set`, `GET`+`DEL` (or Lua) for `get`,
 * `DEL` for `delete`, and an empty no-op `sweep` because Redis expires on its
 * own. Keeping every method `Promise<…>` lets us swap implementations without
 * touching the route handlers.
 *
 * `sweep` returns the number of entries it evicted — handy as a metric so we
 * can detect runaway TTLs or abuse spikes; the in-memory impl uses it from a
 * 5-minute interval so stale tokens don't pile up between accesses.
 */
export interface TokenStore<T> {
  /** Store a value under `key`. Replaces any prior value and resets the TTL. */
  set(key: string, value: T): Promise<void>;
  /** Fetch a value. Returns `null` for missing or expired keys (expired keys are evicted as a side-effect). */
  get(key: string): Promise<T | null>;
  /** Remove a key. Idempotent. */
  delete(key: string): Promise<void>;
  /** Evict all expired entries. Returns the number removed (useful for metrics). */
  sweep(): Promise<number>;
}

interface Entry<T> { value: T; expiresAt: number }

/**
 * In-process Map-backed TokenStore. Each `set` records `now + ttlMs` as the
 * absolute expiry. `get` lazily evicts an expired entry it encounters.
 * `sweep` walks the whole map and drops everything past expiry.
 *
 * Not safe across cloud nodes — use only when there's exactly one process
 * holding the store (SP-2 single-node) or in tests.
 */
export class InMemoryTokenStore<T> implements TokenStore<T> {
  private readonly map = new Map<string, Entry<T>>();
  private readonly ttlMs: number;

  constructor(opts: { ttlMs: number }) {
    if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
      throw new Error("InMemoryTokenStore: ttlMs must be a positive finite number");
    }
    this.ttlMs = opts.ttlMs;
  }

  async set(key: string, value: T): Promise<void> {
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  async get(key: string): Promise<T | null> {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async sweep(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= now) {
        this.map.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
