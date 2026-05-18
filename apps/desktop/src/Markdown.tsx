/**
 * Markdown — streaming-friendly renderer.
 *
 * Wraps `marked` with a stable config and renders to dangerouslySetInnerHTML.
 * Safe for content that comes from a *single user account* (yours) only — do
 * not use this for cross-user content without first running through DOMPurify.
 *
 * Streaming behaviour: re-renders on every text mutation; `marked` parses the
 * partial markdown gracefully (an unclosed code fence is just rendered as
 * literal `\`\`\`` until the second one arrives).
 */
import { useMemo } from "react";
import { marked } from "marked";
import "./markdown.css";

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    link({ href, title, text }: { href: string; title?: string | null; text: string }) {
      const safeTitle = title ? ` title="${escapeAttr(title)}"` : "";
      return `<a href="${escapeAttr(href)}"${safeTitle} target="_blank" rel="noreferrer">${text}</a>`;
    },
  },
});

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => marked.parse(text || "") as string, [text]);
  return <div className={"md" + (className ? " " + className : "")} dangerouslySetInnerHTML={{ __html: html }} />;
}
