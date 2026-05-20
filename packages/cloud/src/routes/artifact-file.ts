/**
 * SP-4 Artifacts: shared helpers for serving a host file's bytes over HTTP.
 *
 * Both the project file-browser (`routes/projects.ts`) and the chat
 * attachment download (`routes/client.ts`) read a file via the host's
 * `read-file` RPC (base64) and stream it to the thin client. This module
 * centralises the path-confinement guard + the base64→HTTP-response mapping
 * so the two call sites can't drift on MIME / disposition / traversal logic.
 */
import type { Context } from "hono";
import { resolve as nodeResolve, sep as nodeSep } from "node:path";

/**
 * True iff `target` resolves to `root` itself or something under it. Guards
 * the file endpoints against `?path=../../etc/passwd` style traversal.
 */
export function pathUnder(root: string, target: string): boolean {
  const r = nodeResolve(root);
  const t = nodeResolve(target);
  return t === r || t.startsWith(r + nodeSep);
}

export interface HostFile {
  contentBase64: string;
  size: number;
  truncated: boolean;
}

/**
 * Turn a host read-file result into an HTTP response. Previewable types render
 * inline (the web viewer iframes HTML / shows images / <pre>s text); everything
 * else downloads. `?download=1` forces attachment regardless.
 */
export function artifactFileResponse(c: Context, path: string, file: HostFile): Response {
  const buf = Buffer.from(file.contentBase64, "base64");
  const name = path.split("/").pop() || "file";
  const mime = mimeFor(name);
  const forceDownload = c.req.query("download") === "1";
  const disposition =
    forceDownload || !PREVIEWABLE.has(mime)
      ? `attachment; filename="${name.replace(/"/g, "")}"`
      : "inline";
  c.header("Content-Type", mime);
  c.header("Content-Disposition", disposition);
  c.header("X-Artifact-Size", String(file.size));
  c.header("X-Artifact-Truncated", String(file.truncated));
  return c.body(buf);
}

export const PREVIEWABLE = new Set([
  "text/html", "text/plain", "text/markdown", "text/css", "application/javascript",
  "application/json", "image/png", "image/jpeg", "image/gif", "image/svg+xml", "image/webp",
]);

export function mimeFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    html: "text/html", htm: "text/html", txt: "text/plain", md: "text/markdown",
    css: "text/css", js: "application/javascript", mjs: "application/javascript",
    ts: "text/plain", tsx: "text/plain", jsx: "text/plain", py: "text/plain",
    json: "application/json", svg: "image/svg+xml", png: "image/png",
    jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  };
  return map[ext] ?? "application/octet-stream";
}
