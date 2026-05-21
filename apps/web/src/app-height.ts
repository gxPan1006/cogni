/**
 * iOS Safari / standalone PWA mis-measures the height of `position: fixed`
 * elements sized with viewport units (100vh / 100dvh) or top:0/bottom:0 on the
 * first paint — they don't settle until a scroll/drag forces a reflow. Our
 * slide-in sidebar drawer hit exactly this: it opened too short, showing a gap
 * at the bottom until you interacted.
 *
 * window.innerHeight, read in JS, is accurate immediately. We publish it as the
 * `--app-h` CSS variable and the drawer uses `height: var(--app-h)`, so it's the
 * right height from the first frame. Re-published on resize / orientation /
 * foreground so it tracks rotation and any later viewport changes.
 */
export function setupAppHeight(): void {
  const set = () => {
    document.documentElement.style.setProperty("--app-h", `${window.innerHeight}px`);
  };
  set();
  window.addEventListener("resize", set);
  window.addEventListener("orientationchange", set);
  // visualViewport tracks iOS viewport changes more faithfully than resize.
  window.visualViewport?.addEventListener("resize", set);
}
