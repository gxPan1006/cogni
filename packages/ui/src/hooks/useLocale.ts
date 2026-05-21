/**
 * useLocale — reactive current language + a setter, for the Settings toggle.
 *
 * Thin wrapper over react-i18next so the 外观/Customize panel reads the live
 * language and flips it. `setLocale` (from ../i18n) persists the choice and
 * calls i18n.changeLanguage; subscribing via useTranslation re-renders this
 * component when the language changes.
 */
import { useTranslation } from "react-i18next";
import { setLocale, type Locale } from "../i18n/index.js";

export function useLocale(): { locale: Locale; setLocale: (l: Locale) => void } {
  const { i18n } = useTranslation();
  const locale = (i18n.resolvedLanguage as Locale) ?? "zh";
  return { locale, setLocale };
}
