/**
 * Cheap, header-only User-Agent parser. SP-2 doesn't bring in `ua-parser-js` —
 * we just produce a humanish label for the settings page. Refinement is fine
 * later; this is purely cosmetic.
 */
export function deriveDeviceName(userAgent: string | undefined, origin: "desktop" | "web"): string {
  if (origin === "desktop") return "Desktop App";
  const ua = (userAgent ?? "").toLowerCase();
  const os =
    ua.includes("iphone") ? "iPhone" :
    ua.includes("ipad") ? "iPad" :
    ua.includes("android") ? "Android" :
    ua.includes("mac os x") || ua.includes("macintosh") ? "macOS" :
    ua.includes("windows") ? "Windows" :
    ua.includes("linux") ? "Linux" : "Unknown";
  const browser =
    ua.includes("edg/") ? "Edge" :
    ua.includes("chrome/") && !ua.includes("edg/") ? "Chrome" :
    ua.includes("safari/") && !ua.includes("chrome/") ? "Safari" :
    ua.includes("firefox/") ? "Firefox" : "Browser";
  return `${browser} on ${os}`;
}
