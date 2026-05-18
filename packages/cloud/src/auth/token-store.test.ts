import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InMemoryTokenStore } from "./token-store.js";

describe("InMemoryTokenStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("set + get on the same key returns the original value", async () => {
    const store = new InMemoryTokenStore<{ email: string }>({ ttlMs: 60_000 });
    await store.set("tok-a", { email: "a@x.com" });
    expect(await store.get("tok-a")).toEqual({ email: "a@x.com" });
  });

  it("get on an expired key returns null and evicts the entry", async () => {
    const store = new InMemoryTokenStore<string>({ ttlMs: 1_000 });
    await store.set("tok", "v");
    vi.advanceTimersByTime(1_500);
    expect(await store.get("tok")).toBeNull();
    // sweep should report 0 because get() already evicted it.
    expect(await store.sweep()).toBe(0);
  });

  it("delete makes a subsequent get return null", async () => {
    const store = new InMemoryTokenStore<string>({ ttlMs: 60_000 });
    await store.set("tok", "v");
    await store.delete("tok");
    expect(await store.get("tok")).toBeNull();
  });

  it("delete on a missing key is a no-op", async () => {
    const store = new InMemoryTokenStore<string>({ ttlMs: 60_000 });
    await expect(store.delete("nope")).resolves.toBeUndefined();
  });

  it("sweep removes only expired entries and reports the count", async () => {
    const store = new InMemoryTokenStore<string>({ ttlMs: 1_000 });
    await store.set("old-1", "v1");
    await store.set("old-2", "v2");
    vi.advanceTimersByTime(1_500);
    await store.set("fresh", "v3");

    const removed = await store.sweep();
    expect(removed).toBe(2);
    expect(await store.get("old-1")).toBeNull();
    expect(await store.get("old-2")).toBeNull();
    expect(await store.get("fresh")).toBe("v3");
  });

  it("set on an existing key overwrites the previous value and resets the TTL", async () => {
    const store = new InMemoryTokenStore<string>({ ttlMs: 1_000 });
    await store.set("tok", "first");
    vi.advanceTimersByTime(800);
    await store.set("tok", "second");
    // first TTL would have expired by now; the reset keeps `second` alive.
    vi.advanceTimersByTime(500);
    expect(await store.get("tok")).toBe("second");
  });

  it("get on an unknown key returns null without throwing", async () => {
    const store = new InMemoryTokenStore<string>({ ttlMs: 60_000 });
    expect(await store.get("never-set")).toBeNull();
  });

  it("rejects a non-positive ttlMs at construction", () => {
    expect(() => new InMemoryTokenStore<string>({ ttlMs: 0 })).toThrow();
    expect(() => new InMemoryTokenStore<string>({ ttlMs: -1 })).toThrow();
    expect(() => new InMemoryTokenStore<string>({ ttlMs: Number.NaN })).toThrow();
  });
});
