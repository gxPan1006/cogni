/**
 * Host-side file-upload staging + materialization.
 *
 * Mirrors fs-browse.ts conventions: a typed error class with stable `code`s
 * the rpc-dispatcher maps onto `{ ok:false, error:{ code, message } }` frames.
 *
 * begin → chunk* → commit moves bytes from a per-upload temp file into the
 * thread's staging dir (~/.cogni/uploads/<threadId>/). materializeUploads()
 * copies a turn's named files into <cwd>/.cogni-uploads/ at dispatch time and,
 * for git worktrees, adds an exclude so they never appear in `git status`.
 *
 * Safety: filenames are reduced to basename (no traversal); a 50MB cap is
 * enforced both at begin (declaredSize fast-reject) and cumulatively on bytes.
 */
import { mkdir, open, rename, unlink, copyFile, readFile, appendFile, access } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { configDir } from "./config.js";
import type {
  UploadBeginRequest, UploadBeginResponse,
  UploadChunkRequest, UploadChunkResponse,
  UploadCommitRequest, UploadCommitResponse,
  UploadAbortRequest, UploadAbortResponse,
} from "@cogni/contract";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
export const UPLOAD_DIRNAME = ".cogni-uploads";

export class UploadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "UploadError";
  }
}

function uploadsRoot(): string {
  return join(configDir(), "uploads");
}
function stagingDir(threadId: string): string {
  return join(uploadsRoot(), threadId);
}

interface Pending {
  threadId: string;
  safeName: string;
  tmpPath: string;
  written: number;
}

export class UploadStore {
  private pending = new Map<string, Pending>();

  async begin(req: UploadBeginRequest): Promise<UploadBeginResponse> {
    if (req.declaredSize > MAX_UPLOAD_BYTES) {
      throw new UploadError("upload-too-large", `declared size ${req.declaredSize} exceeds ${MAX_UPLOAD_BYTES}`);
    }
    const safeName = sanitizeName(req.fileName);
    const dir = stagingDir(req.scope.threadId);
    await mkdir(dir, { recursive: true });
    const uploadId = randomUUID();
    const tmpPath = join(dir, `.partial-${uploadId}`);
    const fh = await open(tmpPath, "w");
    await fh.close();
    this.pending.set(uploadId, { threadId: req.scope.threadId, safeName, tmpPath, written: 0 });
    return { uploadId };
  }

  async chunk(req: UploadChunkRequest): Promise<UploadChunkResponse> {
    const p = this.pending.get(req.uploadId);
    if (!p) throw new UploadError("upload-not-found", `no upload ${req.uploadId}`);
    const buf = Buffer.from(req.dataBase64, "base64");
    if (p.written + buf.length > MAX_UPLOAD_BYTES) {
      await this.cleanup(req.uploadId);
      throw new UploadError("upload-too-large", `cumulative size exceeds ${MAX_UPLOAD_BYTES}`);
    }
    const fh = await open(p.tmpPath, "a");
    try {
      await fh.appendFile(buf);
    } finally {
      await fh.close();
    }
    p.written += buf.length;
    return { received: p.written };
  }

  async commit(req: UploadCommitRequest): Promise<UploadCommitResponse> {
    const p = this.pending.get(req.uploadId);
    if (!p) throw new UploadError("upload-not-found", `no upload ${req.uploadId}`);
    const dir = stagingDir(p.threadId);
    const finalName = await dedupeName(dir, p.safeName);
    const finalPath = join(dir, finalName);
    await rename(p.tmpPath, finalPath);
    this.pending.delete(req.uploadId);
    return { relPath: `${UPLOAD_DIRNAME}/${finalName}`, name: finalName, size: p.written };
  }

  async abort(req: UploadAbortRequest): Promise<UploadAbortResponse> {
    await this.cleanup(req.uploadId);
    return { ok: true };
  }

  private async cleanup(uploadId: string): Promise<void> {
    const p = this.pending.get(uploadId);
    if (!p) return;
    this.pending.delete(uploadId);
    await unlink(p.tmpPath).catch(() => undefined);
  }
}

/**
 * Reduce a client-supplied filename to a safe basename.
 *
 * `basename()` already drops any directory prefix, so "../../etc/passwd"
 * collapses to "passwd" before we touch the regex. The replace is a defensive
 * backstop that strips ONLY the two path separators (`/`, `\`) plus C0 control
 * and DEL bytes (\x00-\x1f, \x7f). Dots, dashes and spaces are intentionally
 * preserved so legitimate names like "hello.txt", "a.txt" or "my file-2.pdf"
 * survive intact — the de-dupe step relies on the extension dot being present.
 */
function sanitizeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = basename(name).replace(/[/\\\x00-\x1f\x7f]/g, "").trim();
  if (!base || base === "." || base === "..") return `upload-${randomUUID().slice(0, 8)}`;
  return base;
}

async function dedupeName(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let i = 1; await exists(join(dir, candidate)); i++) {
    candidate = `${stem}-${i}${ext}`;
  }
  return candidate;
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/**
 * Copy this turn's staged files into <cwd>/.cogni-uploads/. For a git worktree
 * (a .git dir/file exists), append `.cogni-uploads/` to .git/info/exclude so
 * the uploads never pollute `git status`. Best-effort per file: a missing
 * staged file is skipped, not fatal (re-dispatch / resume tolerance).
 */
export async function materializeUploads(
  threadId: string,
  attachments: { name: string }[],
  cwd: string,
): Promise<void> {
  if (attachments.length === 0) return;
  const dest = join(cwd, UPLOAD_DIRNAME);
  await mkdir(dest, { recursive: true });
  const stage = stagingDir(threadId);
  for (const a of attachments) {
    const src = join(stage, a.name);
    await copyFile(src, join(dest, a.name)).catch(() => undefined);
  }
  await ensureGitExclude(cwd);
}

async function ensureGitExclude(cwd: string): Promise<void> {
  const infoDir = join(cwd, ".git", "info");
  // A git worktree is identified by the .git/info dir. If it's absent this is
  // not a worktree and there's nothing to exclude.
  if (!(await exists(infoDir))) return;
  const excludePath = join(infoDir, "exclude");
  // exclude may not exist yet; treat a read failure as an empty file so we
  // create it. appendFile creates the file when missing.
  const current = await readFile(excludePath, "utf8").catch(() => "");
  if (current.includes(`${UPLOAD_DIRNAME}/`)) return;
  await appendFile(excludePath, `\n${UPLOAD_DIRNAME}/\n`);
}
