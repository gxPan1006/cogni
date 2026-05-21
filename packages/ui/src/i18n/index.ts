/**
 * i18n — app-wide Chinese / English language switching.
 *
 * Built on i18next + react-i18next. This module self-initialises on first
 * import (init is synchronous because all resources are bundled inline), so by
 * the time any component calls `useTranslation()` the catalog is ready and the
 * correct language is on screen from first paint.
 *
 * Language is chosen once at boot:
 *   1. an explicit choice the user saved before  → localStorage["cogni.locale"]
 *   2. otherwise the OS/browser language          → navigator.language
 *   3. fallback                                   → "zh"
 *
 * Switching is reactive: `setLocale()` calls `i18n.changeLanguage()`, which
 * react-i18next subscribes to, so the whole UI re-renders instantly with no
 * reload. We also mirror the choice onto `<html lang>` (like useTheme mirrors
 * `data-theme`), fixing the otherwise-stale `lang="en"` in index.html.
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { zh } from "./locales/zh.js";
import { en } from "./locales/en.js";

export type Locale = "zh" | "en";

const STORAGE_KEY = "cogni.locale";

function readStored(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "zh" || v === "en" ? v : null;
  } catch {
    return null; // private mode / no storage
  }
}

/** Saved choice wins; else OS language (en* → en); else Chinese. */
function detect(): Locale {
  const stored = readStored();
  if (stored) return stored;
  if (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("en")) {
    return "en";
  }
  return "zh";
}

const initial = detect();

void i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: initial,
  fallbackLng: "zh",
  interpolation: { escapeValue: false }, // React already escapes
  returnNull: false,
});

if (typeof document !== "undefined") document.documentElement.lang = initial;

/** Switch language app-wide and persist the choice. */
export function setLocale(next: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* private mode / no storage */
  }
  void i18n.changeLanguage(next);
  if (typeof document !== "undefined") document.documentElement.lang = next;
}

/** The language in effect right now. */
export function getLocale(): Locale {
  return (i18n.resolvedLanguage as Locale) ?? initial;
}

export { i18n };
