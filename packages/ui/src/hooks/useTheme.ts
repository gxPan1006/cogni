/**
 * useTheme — app-wide light / dark / follow-system theme.
 *
 * A tiny external store (no context, no prop-drilling) so both the app root
 * and the Settings → 外观 panel read/write the same preference. The chosen
 * preference is persisted to localStorage and applied by setting
 * `data-theme="light|dark"` on <html>, which flips the token set defined in
 * each app's `styles/tokens.css` (`:root` vs `[data-theme="dark"]`).
 *
 * "system" follows the OS `prefers-color-scheme` and re-applies live when the
 * OS toggles. The module applies the stored preference at import time, so the
 * correct theme is on screen from first paint (SettingsPage is statically
 * imported by both app shells, so this module loads at boot).
 */
import { useSyncExternalStore } from "react";

export type ThemePref = "light" | "dark" | "system";

const STORAGE_KEY = "cogni.theme";

function readStored(): ThemePref {
  if (typeof localStorage === "undefined") return "system";
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

let pref: ThemePref = readStored();
const listeners = new Set<() => void>();

function systemPrefersDark(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
}

/** The actual light/dark the preference resolves to right now. */
function resolved(p: ThemePref): "light" | "dark" {
  return p === "system" ? (systemPrefersDark() ? "dark" : "light") : p;
}

function apply(): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolved(pref));
}

// Watch the OS setting once; only re-applies while the preference is "system".
if (typeof matchMedia !== "undefined") {
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const onSystemChange = () => { if (pref === "system") apply(); };
  if (mq.addEventListener) mq.addEventListener("change", onSystemChange);
  else if (mq.addListener) mq.addListener(onSystemChange); // older webviews
}

// Apply the stored preference on first import — before the UI mounts.
apply();

export function setThemePref(next: ThemePref): void {
  pref = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode / no storage */ }
  apply();
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** `{ pref, setPref }` — reactive theme preference for any component. */
export function useTheme(): { pref: ThemePref; setPref: (p: ThemePref) => void } {
  const current = useSyncExternalStore(subscribe, () => pref, () => pref);
  return { pref: current, setPref: setThemePref };
}
