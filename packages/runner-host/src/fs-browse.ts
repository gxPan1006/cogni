/**
 * SP-3 host-side `fs-browse` RPC handler.
 *
 * Used by the web NewProject "📁 Browse" step: the user picks a host, then
 * navigates the host's filesystem to choose a `repoPath`. Browsing happens
 * directory-by-directory — each request lists exactly ONE directory.
 *
 * Safety invariants (spec §七 #4):
 *   - Only list directory entries; NEVER read file bodies. The `size` field
 *     comes from `stat`, which is metadata-only.
 *   - Hidden entries (names starting with `.`) are filtered by default; we
 *     only include them when the *requested* path itself is hidden (so a
 *     user who explicitly types `~/.config` sees the contents).
 *   - The path MUST be absolute. Relative paths could be resolved against
 *     an unintended cwd (the runner-host daemon's process cwd is not
 *     well-defined and not under user control).
 *
 * Errors are thrown as `FsBrowseError` and the dispatcher maps them onto
 * `{ ok: false, error: { code, message } }` response frames. Codes are
 * stable strings the cloud / UI can branch on.
 */

import { readdir, stat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { expandTilde } from "./paths.js";
import type {
  FsBrowseRequest, FsBrowseResponse, FsBrowseEntry,
  ReadFileRequest, ReadFileResponse,
} from "@cogni/contract";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export class FsBrowseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "FsBrowseError";
  }
}

/**
 * List one directory. Files appear with `size`; dirs without. Special device
 * entries (symlinks, sockets, etc.) are filtered — the contract enum only
 * accepts `"file" | "dir"`, and the spec only needs those two kinds for repo
 * picking.
 */
export async function fsBrowse(req: FsBrowseRequest): Promise<FsBrowseResponse> {
  // Default path when none provided — spec §七 says host picks a sensible
  // default (we use $HOME, which matches what the web UI's "📁 Browse"
  // button is conceptually doing: "show me where my code lives").
  const requestedPath = expandTilde(req.path ?? homedir());
  if (!isAbsolute(requestedPath)) {
    throw new FsBrowseError("path-must-be-absolute", `path must be absolute: ${requestedPath}`);
  }
  const cwd = resolve(requestedPath);

  // Surface stat errors with stable codes so the UI can render meaningful messages
  // (e.g. "Folder not found" vs "Permission denied") instead of raw POSIX text.
  let st;
  try {
    st = await stat(cwd);
  } catch (e: unknown) {
    const code = errCode(e);
    if (code === "ENOENT") throw new FsBrowseError("path-not-found", `path does not exist: ${cwd}`);
    if (code === "EACCES" || code === "EPERM") {
      throw new FsBrowseError("permission-denied", `permission denied: ${cwd}`);
    }
    throw new FsBrowseError("stat-failed", `${code ?? "unknown"}: ${cwd}`);
  }
  if (!st.isDirectory()) {
    throw new FsBrowseError("not-a-directory", `path is not a directory: ${cwd}`);
  }

  // Whether the *target* dir is itself hidden — if so, the user explicitly
  // navigated into a hidden tree and presumably wants to see what's there.
  const targetIsHidden = basename(cwd).startsWith(".");

  let dirents;
  try {
    dirents = await readdir(cwd, { withFileTypes: true });
  } catch (e: unknown) {
    const code = errCode(e);
    if (code === "EACCES" || code === "EPERM") {
      throw new FsBrowseError("permission-denied", `permission denied: ${cwd}`);
    }
    throw new FsBrowseError("readdir-failed", `${code ?? "unknown"}: ${cwd}`);
  }

  const entries: FsBrowseEntry[] = [];
  for (const d of dirents) {
    if (!targetIsHidden && d.name.startsWith(".")) continue;
    // Filter to plain files / dirs. Symlinks would need `stat` (not `lstat`)
    // to resolve their target, plus loop detection — out of scope for SP-3.
    if (d.isDirectory()) {
      entries.push({ name: d.name, type: "dir" });
    } else if (d.isFile()) {
      // Per-entry stat to capture size. Best-effort — if stat fails on a
      // single file (e.g. broken symlink in the wild) we just omit size
      // rather than failing the whole listing.
      let size: number | undefined;
      try {
        const fst = await stat(`${cwd}/${d.name}`);
        size = fst.size;
      } catch {
        size = undefined;
      }
      entries.push(size != null ? { name: d.name, type: "file", size } : { name: d.name, type: "file" });
    }
    // else: symlinks, sockets, fifos, char/block devices → skipped
  }

  // Sort: dirs first (so users navigating to repo roots find folders at the
  // top), then files; alphabetical inside each group. Stable comparator.
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { entries, cwd };
}

/**
 * SP-4 Artifacts: read a single file's bytes for delivery to a thin client.
 * The cloud route confines `path` to an allowed root (project repo / thread
 * scratch dir) before calling — here we only enforce: absolute path, real
 * file (not dir), and a byte cap so a huge file can't blow the WS frame.
 * Returns base64 (binary-safe over JSON) + the true size + a truncated flag.
 */
export async function readFile(req: ReadFileRequest): Promise<ReadFileResponse> {
  if (!isAbsolute(req.path)) {
    throw new FsBrowseError("path-must-be-absolute", `path must be absolute: ${req.path}`);
  }
  const abs = resolve(req.path);
  const cap = req.maxBytes ?? DEFAULT_MAX_BYTES;

  let st;
  try {
    st = await stat(abs);
  } catch (e: unknown) {
    const code = errCode(e);
    if (code === "ENOENT") throw new FsBrowseError("path-not-found", `file does not exist: ${abs}`);
    if (code === "EACCES" || code === "EPERM") throw new FsBrowseError("permission-denied", `permission denied: ${abs}`);
    throw new FsBrowseError("stat-failed", `${code ?? "unknown"}: ${abs}`);
  }
  if (st.isDirectory()) throw new FsBrowseError("is-a-directory", `path is a directory: ${abs}`);
  if (!st.isFile()) throw new FsBrowseError("not-a-file", `path is not a regular file: ${abs}`);

  const sliceLen = Math.min(st.size, cap);
  const buf = Buffer.alloc(sliceLen);
  const fh = await open(abs, "r");
  try {
    if (sliceLen > 0) await fh.read(buf, 0, sliceLen, 0);
  } finally {
    await fh.close();
  }
  return {
    contentBase64: buf.toString("base64"),
    size: st.size,
    truncated: st.size > sliceLen,
  };
}

function errCode(e: unknown): string | undefined {
  if (e && typeof e === "object" && "code" in e) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}
