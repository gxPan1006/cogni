import { useEffect } from "react";

/**
 * Auto-hide scrollbars app-wide.
 *
 * Scrollbar thumbs are transparent by default in CSS (see base.css). This hook
 * installs one capture-phase `scroll` listener that tags whichever element is
 * actively scrolling with an `is-scrolling` class, then removes it after a
 * short idle. The CSS reveals the thumb only while that class is present, so
 * the scrollbar appears while the user scrolls and fades out when they stop.
 */
export function useAutoHideScrollbars(idleMs = 900): void {
  useEffect(() => {
    const timers = new WeakMap<HTMLElement, number>();
    const onScroll = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLElement)) return;
      el.classList.add("is-scrolling");
      const prev = timers.get(el);
      if (prev !== undefined) window.clearTimeout(prev);
      timers.set(
        el,
        window.setTimeout(() => el.classList.remove("is-scrolling"), idleMs),
      );
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [idleMs]);
}
