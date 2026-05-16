import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { RateLimiter } from "./rate-limit.js";

describe("RateLimiter", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-05-16T00:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("allows N hits within the window, blocks the N+1th", () => {
    const rl = new RateLimiter([{ windowMs: 60_000, max: 3 }]);
    expect(rl.check("k")).toBe(true);
    expect(rl.check("k")).toBe(true);
    expect(rl.check("k")).toBe(true);
    expect(rl.check("k")).toBe(false);
  });

  it("resets the counter once the window has slid past all hits", () => {
    const rl = new RateLimiter([{ windowMs: 60_000, max: 2 }]);
    expect(rl.check("k")).toBe(true);
    expect(rl.check("k")).toBe(true);
    expect(rl.check("k")).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(rl.check("k")).toBe(true);
  });

  it("enforces multiple windows simultaneously (per-min AND per-hour)", () => {
    const rl = new RateLimiter([
      { windowMs: 60_000, max: 1 },
      { windowMs: 3_600_000, max: 5 },
    ]);
    expect(rl.check("k")).toBe(true);                  // 1 in min, 1 in hour
    expect(rl.check("k")).toBe(false);                 // blocked by per-min
    vi.advanceTimersByTime(60_001);
    expect(rl.check("k")).toBe(true);                  // per-min reset; 2 in hour
    vi.advanceTimersByTime(60_001);
    expect(rl.check("k")).toBe(true);                  // 3
    vi.advanceTimersByTime(60_001);
    expect(rl.check("k")).toBe(true);                  // 4
    vi.advanceTimersByTime(60_001);
    expect(rl.check("k")).toBe(true);                  // 5
    vi.advanceTimersByTime(60_001);
    expect(rl.check("k")).toBe(false);                 // blocked by per-hour
  });

  it("buckets by key — separate keys do not share counters", () => {
    const rl = new RateLimiter([{ windowMs: 60_000, max: 1 }]);
    expect(rl.check("a")).toBe(true);
    expect(rl.check("b")).toBe(true);
    expect(rl.check("a")).toBe(false);
    expect(rl.check("b")).toBe(false);
  });
});
