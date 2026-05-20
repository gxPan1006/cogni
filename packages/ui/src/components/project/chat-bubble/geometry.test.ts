import { describe, it, expect } from "vitest";
import {
  clampCenter,
  computePanelRect,
  BUBBLE_W,
  BUBBLE_H,
  PAD,
  PANEL_W,
  PANEL_H_MAX,
} from "./geometry.js";

describe("clampCenter", () => {
  it("keeps a centred position untouched", () => {
    expect(clampCenter({ x: 640, y: 400 }, 1280, 800)).toEqual({ x: 640, y: 400 });
  });

  it("pulls an off-screen-left/top position back inside by half the pill + pad", () => {
    expect(clampCenter({ x: -100, y: -100 }, 1280, 800)).toEqual({
      x: BUBBLE_W / 2 + PAD,
      y: BUBBLE_H / 2 + PAD,
    });
  });

  it("pulls an off-screen-right/bottom position back inside", () => {
    expect(clampCenter({ x: 5000, y: 5000 }, 1280, 800)).toEqual({
      x: 1280 - BUBBLE_W / 2 - PAD,
      y: 800 - BUBBLE_H / 2 - PAD,
    });
  });
});

describe("computePanelRect", () => {
  it("default (no pos) anchors a full-width panel above the bottom-centre pill", () => {
    const r = computePanelRect(null, 1280, 800);
    expect(r.width).toBe(PANEL_W);
    expect(r.height).toBe(PANEL_H_MAX); // plenty of room on an 800px-tall viewport
    // horizontally centred: left = vw/2 - PANEL_W/2
    expect(r.left).toBe(1280 / 2 - PANEL_W / 2);
    expect(r.top).toBeGreaterThanOrEqual(16);
  });

  it("never spills off the top — height shrinks when the pill is near the top", () => {
    const r = computePanelRect({ x: 640, y: 120 }, 1280, 800);
    expect(r.top).toBeGreaterThanOrEqual(16);
    expect(r.height).toBeLessThan(PANEL_H_MAX);
  });

  it("clamps left/right so a pill in the corner keeps the panel ≥16px from the edge", () => {
    const right = computePanelRect({ x: 1270, y: 400 }, 1280, 800);
    expect(right.left).toBe(1280 - PANEL_W - 16);
    const left = computePanelRect({ x: 10, y: 400 }, 1280, 800);
    expect(left.left).toBe(16);
  });
});
