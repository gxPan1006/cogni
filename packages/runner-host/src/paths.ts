/**
 * Host-side path normalization shared by the git-ops + fs-browse RPC handlers.
 *
 * Cloud-supplied paths (project.repoPath, derived worktree paths) are opaque
 * strings the user typed or the NewProject browser produced. A user who types
 * `~/code/foo` expects the shell's home-dir expansion — but `path.resolve()`
 * does NOT expand `~` (only a shell does). Worse, the runner-host daemon's cwd
 * is typically `/` (launched by launchd / the Tauri sidecar), so
 * `resolve("~/code/foo")` yields `/~/code/foo`, and `git init` then tries to
 * `mkdir /~` on the read-only macOS system volume → every dispatch fails and
 * the task is stuck `queued` forever.
 *
 * Expanding `~` here, at the only layer that knows the host's real home dir,
 * fixes it uniformly for every git op and for the fs-browse picker.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Replace a leading `~` / `~/` with the user's home directory. Other forms
 *  (`~otheruser`, embedded `~`) are left untouched — git/fs handle those. */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Expand `~` then resolve to an absolute path. Use for any cloud-supplied
 *  path before handing it to `git`/`fs`. */
export function resolveUserPath(p: string): string {
  return resolve(expandTilde(p));
}
