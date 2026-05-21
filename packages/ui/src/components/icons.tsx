/**
 * Shared stroke icons. Single source of truth — every component imports `Icon.foo`
 * instead of inlining its own SVGs.
 *
 * Each icon is a 24×24 viewBox; size and stroke colour are controlled by parent CSS
 * (icons inherit `currentColor` and scale with their wrapper's `width`/`height`).
 */
import type { JSX } from "react";

const wrap = (children: JSX.Element, strokeWidth = 1.6, fill: "none" | "currentColor" = "none") => (
  <svg
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    fill={fill}
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const Icon = {
  chat:    wrap(<path d="M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.5A8 8 0 1 1 21 12z" />),
  kanban:  wrap(<>
    <rect x="3" y="4" width="5" height="16" rx="1" />
    <rect x="10" y="4" width="5" height="10" rx="1" />
    <rect x="17" y="4" width="4" height="13" rx="1" />
  </>),
  plus:    wrap(<path d="M12 5v14M5 12h14" />),
  search:  wrap(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>),
  send:    wrap(<path d="M5 12h14M13 6l6 6-6 6" />),
  stop:    wrap(<rect x="7" y="7" width="10" height="10" rx="2" />, 0, "currentColor"),
  cog:     wrap(<>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8L4.2 7a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </>),
  user:    wrap(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>),
  folder:  wrap(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />),
  spark:   wrap(<path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z" />),
  panel:   wrap(<>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </>),
  menu:    wrap(<path d="M4 6h16M4 12h16M4 18h16" />),
  more:    wrap(<path d="M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm0-6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm0 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" />, 0, "currentColor"),
  tool:    wrap(<path d="M14.7 6.3a4 4 0 0 0 5 5l-1.7 1.7-9 9a2 2 0 1 1-3-3l9-9z" />),
  brain:   wrap(<path d="M9 4a3 3 0 0 0-3 3v.5A2.5 2.5 0 0 0 3.5 10v1A2.5 2.5 0 0 0 6 13.5V14a3 3 0 0 0 3 3v3a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-3a3 3 0 0 0 3-3v-.5a2.5 2.5 0 0 0 2.5-2.5V10A2.5 2.5 0 0 0 18 7.5V7a3 3 0 0 0-3-3" />),
  file:    wrap(<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" />),
  check:   wrap(<path d="M5 12l5 5L20 6" />),
  x:       wrap(<path d="M6 6l12 12M6 18L18 6" />),
  arrow:   wrap(<path d="M5 12h14M13 6l6 6-6 6" />),
  attach:  wrap(<path d="M21 11.5l-9.2 9.2a5.5 5.5 0 0 1-7.8-7.8L13.5 4a3.7 3.7 0 0 1 5.3 5.3L9.4 18.6a1.8 1.8 0 0 1-2.6-2.6l8.3-8.3" />),
  shield:  wrap(<path d="M12 3l8 3v5c0 5-4 9-8 10-4-1-8-5-8-10V6z" />),
  flow:    wrap(<>
    <circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" />
    <circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" />
    <path d="M8 6h8M6 8v8M18 8v8M8 18h8" />
  </>),
  globe:   wrap(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>),
  desktop: wrap(<><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M8 21h8M12 16v5" /></>),
  phone:   wrap(<><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" /></>),
  bolt:    wrap(<path d="M13 3L5 14h6l-1 7 8-11h-6z" />),
  refresh: wrap(<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />),
  link:    wrap(<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />),
  edit:    wrap(<path d="M16 3l5 5L8 21H3v-5z" />),
  trash:   wrap(<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />),
  sun:     wrap(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M5 5l1.5 1.5M17.5 17.5L19 19M2 12h2M20 12h2M5 19l1.5-1.5M17.5 6.5L19 5" /></>),
  moon:    wrap(<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z" />),
  logout:  wrap(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></>),
};
