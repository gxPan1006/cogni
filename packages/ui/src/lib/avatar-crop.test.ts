import { describe, it, expect } from "vitest";
import { displayScale, clampOffset, sourceRect } from "./avatar-crop.js";

describe("avatar-crop math", () => {
  it("displayScale covers the viewport at zoom 1 using the shorter side", () => {
    // 1000×500 image into a 250px viewport: shorter side = 500 → 250/500 = 0.5
    expect(displayScale(1000, 500, 250, 1)).toBeCloseTo(0.5);
    expect(displayScale(1000, 500, 250, 2)).toBeCloseTo(1.0);
  });

  it("clampOffset keeps the viewport fully covered (offsets in [viewport - disp, 0])", () => {
    // disp size at scale 0.5: 1000*0.5=500 wide, 500*0.5=250 tall, viewport 250
    const scale = 0.5;
    // x can range [250-500, 0] = [-250, 0]; y range [250-250,0] = [0,0]
    expect(clampOffset(-1000, 1000, 500, 250, scale)).toBe(-250); // clamp low
    expect(clampOffset(100, 1000, 500, 250, scale)).toBe(0);      // clamp high
    expect(clampOffset(-100, 1000, 500, 250, scale)).toBe(-100);  // within range
    expect(clampOffset(50, 1000, 500, 250, scale)).toBe(0);       // y fully pinned
  });

  it("sourceRect maps the viewport square back to source pixels", () => {
    // square image 500×500, viewport 250, zoom 1 → scale 0.5, offset 0,0
    // viewport covers source [0,0]..[500,500]
    const r = sourceRect(500, 500, 250, 0.5, 0, 0);
    expect(r).toEqual({ sx: 0, sy: 0, sw: 500, sh: 500 });
  });

  it("sourceRect shifts the source origin when panned", () => {
    // offsetX -125 px at scale 0.5 → source x starts at 250
    const r = sourceRect(1000, 500, 250, 0.5, -125, 0);
    expect(r.sx).toBeCloseTo(250);
    expect(r.sw).toBeCloseTo(500);
  });
});
