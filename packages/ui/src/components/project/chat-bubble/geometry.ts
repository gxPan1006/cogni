/**
 * Pure layout math for the chat bubble — kept React/CSS-free so it can be
 * unit-tested under the `node` vitest environment (importing ChatBubble.tsx
 * would drag in chat-bubble.css and break that).
 *
 *   - `clampCenter` keeps the dragged pill fully inside the viewport.
 *   - `computePanelRect` positions the popover above the pill, also clamped.
 */
export interface Pos {
  x: number;
  y: number;
}
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const POS_KEY = "cogni:cb:pos:v1";
export const PAD = 12;
export const BUBBLE_W = 124;
export const BUBBLE_H = 52;
export const PANEL_W = 400;
export const PANEL_H_MAX = 620;
export const PANEL_GAP = 14;
export const DRAG_THRESHOLD = 4;
/** Default bottom-centre offset of the pill when never dragged. */
export const DEFAULT_BOTTOM = 104;

/** Clamp a bubble centre so the whole pill stays inside the viewport. */
export function clampCenter(p: Pos, vw: number, vh: number, w = BUBBLE_W, h = BUBBLE_H): Pos {
  return {
    x: Math.max(w / 2 + PAD, Math.min(vw - w / 2 - PAD, p.x)),
    y: Math.max(h / 2 + PAD, Math.min(vh - h / 2 - PAD, p.y)),
  };
}

/**
 * Popover rectangle: anchored `PANEL_GAP` above the pill, horizontally centred
 * on it, height capped at `PANEL_H_MAX` (and never spilling off the top), always
 * kept ≥16px from every viewport edge. `pos === null` ⇒ the default
 * bottom-centre pill.
 */
export function computePanelRect(pos: Pos | null, vw: number, vh: number): Rect {
  const cx = pos ? pos.x : vw / 2;
  const bubbleTop = pos ? pos.y - BUBBLE_H / 2 : vh - DEFAULT_BOTTOM - BUBBLE_H / 2;
  const height = Math.min(PANEL_H_MAX, bubbleTop - 24);
  const left = Math.max(16, Math.min(vw - PANEL_W - 16, cx - PANEL_W / 2));
  const top = Math.max(16, bubbleTop - PANEL_GAP - height);
  return { left, top, width: PANEL_W, height };
}
