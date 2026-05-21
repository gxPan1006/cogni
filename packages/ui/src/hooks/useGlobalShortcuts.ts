/**
 * useGlobalShortcuts — app-wide keyboard shortcuts shown in Settings → 外观.
 *
 * Registers a single document-level keydown listener for the shell-level
 * shortcuts. Handlers are read through a ref so the listener subscribes once
 * and never needs the host to memoize its callbacks.
 *
 *   ⌘N / Ctrl+N        新对话      onNewChat
 *   ⌘\ / Ctrl+\        折叠侧边栏  onToggleSidebar
 *   ⌘⇧M / Ctrl+Shift+M 切换 chat↔project  onToggleMode
 *   ⌘, / Ctrl+,        打开设置    onOpenSettings
 *
 * (⌘K 搜索 lives in Sidebar — it focuses the rail's own search input — so it
 * isn't handled here.)
 */
import { useEffect, useRef } from "react";

export type GlobalShortcutHandlers = {
  onNewChat?: () => void;
  onToggleSidebar?: () => void;
  onToggleMode?: () => void;
  onOpenSettings?: () => void;
};

export function useGlobalShortcuts(handlers: GlobalShortcutHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const h = ref.current;
      const k = e.key.toLowerCase();

      // ⌘⇧M — the only shift combo.
      if (e.shiftKey) {
        if (k === "m" && h.onToggleMode) { e.preventDefault(); h.onToggleMode(); }
        return;
      }
      if (e.altKey) return;

      if (k === "n" && h.onNewChat) { e.preventDefault(); h.onNewChat(); }
      else if (k === "\\" && h.onToggleSidebar) { e.preventDefault(); h.onToggleSidebar(); }
      else if (k === "," && h.onOpenSettings) { e.preventDefault(); h.onOpenSettings(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
