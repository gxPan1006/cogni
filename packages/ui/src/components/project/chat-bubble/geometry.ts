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

export interface Size {
  w: number;
  h: number;
}

export const POS_KEY = "cogni:cb:pos:v1";
export const SIZE_KEY = "cogni:cb:size:v1";
export const PAD = 12;
export const BUBBLE_W = 124;
export const BUBBLE_H = 52;
export const PANEL_W = 400;
export const PANEL_H_MAX = 620;
export const PANEL_GAP = 14;
export const DRAG_THRESHOLD = 4;
/** User-resize bounds (the upper bound is also capped by the room above the pill). */
export const PANEL_MIN_W = 320;
export const PANEL_MIN_H = 280;
export const EDGE = 16;
/** Default bottom-centre offset of the pill when never dragged. */
export const DEFAULT_BOTTOM = 104;

/** Clamp a bubble centre so the whole pill stays inside the viewport. */
export function clampCenter(p: Pos, vw: number, vh: number, w = BUBBLE_W, h = BUBBLE_H): Pos {
  return {
    x: Math.max(w / 2 + PAD, Math.min(vw - w / 2 - PAD, p.x)),
    y: Math.max(h / 2 + PAD, Math.min(vh - h / 2 - PAD, p.y)),
  };
}

/** Top edge (y) of the pill, from which the popover hangs upward. */
export function panelBubbleTop(pos: Pos | null, vh: number): number {
  return pos ? pos.y - BUBBLE_H / 2 : vh - DEFAULT_BOTTOM - BUBBLE_H / 2;
}

/**
 * Clamp a user-dragged panel size: width within [MIN_W, viewport−2·EDGE],
 * height within [MIN_H, room above the pill]. So a resize can never push the
 * panel off-screen or over the pill.
 */
export function clampSize(w: number, h: number, pos: Pos | null, vw: number, vh: number): Size {
  const maxH = panelBubbleTop(pos, vh) - 24;
  return {
    w: Math.max(PANEL_MIN_W, Math.min(vw - 2 * EDGE, w)),
    h: Math.max(PANEL_MIN_H, Math.min(maxH, h)),
  };
}

/**
 * Popover rectangle: anchored `PANEL_GAP` above the pill, horizontally centred
 * on it, kept ≥16px from every viewport edge and never spilling over the pill.
 * `size` is the user's dragged dimensions (null ⇒ defaults 400 × up-to-620).
 * `pos === null` ⇒ the default bottom-centre pill.
 */
export function computePanelRect(
  pos: Pos | null,
  vw: number,
  vh: number,
  size?: Size | null,
): Rect {
  const cx = pos ? pos.x : vw / 2;
  const bubbleTop = panelBubbleTop(pos, vh);
  const width = Math.min(size?.w ?? PANEL_W, vw - 2 * EDGE);
  const height = Math.min(size?.h ?? PANEL_H_MAX, bubbleTop - 24);
  const left = Math.max(EDGE, Math.min(vw - width - EDGE, cx - width / 2));
  const top = Math.max(EDGE, bubbleTop - PANEL_GAP - height);
  return { left, top, width, height };
}
