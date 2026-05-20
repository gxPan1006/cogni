# Default project folder + configurable host projects-root

**Status:** approved design, pending implementation plan
**Date:** 2026-05-20
**Author:** brainstormed with the user

## Problem

Creating a project today requires the user to supply the repo's path on the
host: `NewProject.tsx` has a required `repoPath` text field (web also offers a
`fs-browse` directory picker; desktop a native picker). Two pains:

1. **Friction.** The user must already have a folder and know/type its absolute
   path before the project does anything.
2. **A footgun that strands tasks.** A user typed `~/code/cc-view`. The host's
   git-ops resolved it with `path.resolve()`, which does **not** expand `~`;
   with the daemon's cwd at `/` it became `/~/code/cc-view`, so `git init`
   failed (`cannot mkdir /~: Read-only file system`) on every 5s orchestrator
   tick. The task sat in `queued` forever with no error surfaced to the UI.
   (The tilde-expansion half of this is fixed separately in `runner-host`'s
   `paths.ts`; see "Relationship to the tilde fix" below.)

## Goal

When creating a project, **pre-fill** the repo path with a sensible default
derived from a **configurable per-host "projects root"** (default `~/cogni`),
so the common case is "type a name, click create" and a real folder is created
+ `git init`-ed. Keep manual entry / browse for existing repos.

Out of scope: changing the worktree layout, multi-repo projects, remote
(non-host) repos, slug collision auto-dedup (v1 lets the user see + edit a
colliding suggestion).

## User-visible behavior

- **New project modal.** User types a name (e.g. `本地工具显示器`). The repo-path
  field auto-fills to `<host.projectsRoot>/<sanitized-name>`, shown as the
  expanded absolute path (e.g. `/Users/guoxunpan/cogni/本地工具显示器`). The
  suggestion tracks the name as the user types, and re-computes if the user
  switches the default host.
- The moment the user edits the path field manually (or picks via browse), the
  field becomes "dirty" and stops auto-tracking — their input is never
  clobbered.
- The existing "auto `git init`" checkbox stays on by default; on create, the
  host creates the folder (incl. missing parents) and `git init`s it. The task
  dispatches normally instead of stranding in `queued`.
- **Settings → Runner Hosts.** Each host shows an editable "项目根目录" field
  (default `~/cogni`). Saving writes it on the host; subsequent new-project
  pre-fills use the new root. If the host has `COGNI_PROJECTS_ROOT` set in its
  environment, the field is read-only with a "由环境变量锁定" hint (env wins).
- **Edge cases.** Host offline or an old host that doesn't report a projectsRoot
  → no pre-fill, fall back to today's manual entry (no error). Suggestion
  colliding with an existing folder → shown as-is; user edits if needed.

## Architecture

Four layers; each change is small and independently testable.

### 1. runner-host

- **`paths.ts`** (already added for the tilde fix) exposes `expandTilde` /
  `resolveUserPath`.
- **Projects-root resolution.** New helper resolves the root in priority order:
  `COGNI_PROJECTS_ROOT` env → `projectsRoot` key in `~/.cogni/host.json` →
  default `~/cogni`. The result is `expandTilde`-d to an absolute path. A
  `source: "env" | "config" | "default"` flag travels with it so the UI can
  lock the field when env-pinned.
- **Register frame** carries `projectsRoot` (absolute) **and**
  `projectsRootLocked: boolean` (true when `COGNI_PROJECTS_ROOT` pins it) so the
  cloud + UI learn both without an extra round-trip.
- **`set-projects-root` RPC handler.** Writes the new value into
  `~/.cogni/host.json` and returns the resolved absolute path + `locked` flag.
  Refuses to write (returns the env value with `locked: true`, unchanged) when
  `COGNI_PROJECTS_ROOT` is set. The cloud route — not a host re-register —
  persists the returned value onto `hosts.projects_root` and broadcasts a host
  update, so the UI refreshes. (The cloud register handler is idempotent on a
  single socket, so a re-register can't carry the new value.)
- **`gitInitIfMissing`** does a recursive `mkdir -p` of `repoPath` before
  `git init`, so an auto-folder under a not-yet-existing root is created
  reliably (don't depend on git's own leading-dir creation).

### 2. contract

- `register` schema (`hostToCloudSchema`): add optional `projectsRoot: z.string()`
  and `projectsRootLocked: z.boolean().optional()`.
- `hostRpcRequestSchema`: add `{ method: "set-projects-root", params: { projectsRoot: string } }`
  with matching request/response schemas (`setProjectsRootRequestSchema` →
  `{ projectsRoot }`, response → `{ projectsRoot: string, source: "env" | "config" | "default" }`).

### 3. cloud

- `hosts` table: add `projects_root text` + `projects_root_locked boolean`
  columns (nullable; old rows null → UI falls back to no pre-fill). Idempotent
  migration script under
  `packages/cloud/src/scripts/migrate-2026-05-20-host-projects-root.ts`.
- Register handler (`host-ws.ts`): persist `projectsRoot` onto the host row.
- `GET /hosts`: include `projectsRoot` in the response payload.
- New route `PUT /api/hosts/:id/projects-root` (in `routes/projects.ts`, where
  the `ProjectDomain` + `HostRpcClient` deps live; ownership re-checked).
  Calls `hostRpc.setProjectsRoot`, then persists the returned resolved value
  onto `hosts.projects_root` / `hosts.projects_root_locked` and broadcasts a
  host update (`publishHostMeta`) so open clients refresh.

### 4. ui

- `HostInfo` (transport/api.ts): add `projectsRoot?: string` and
  `projectsRootLocked?: boolean`.
- **`NewProject.tsx`**: add a `pathDirty` flag (default false). A derived
  suggestion `joinPath(selectedHost.projectsRoot, sanitize(name))` is written
  into `repoPath` whenever name or selected host changes **and** `pathDirty` is
  false. `onChange` of the path input and the browse picker set `pathDirty`.
  `sanitize(name)`: trim, drop `/` and control chars, collapse whitespace to
  `-`, keep unicode; empty name → empty suggestion (no pre-fill).
- **`SettingsPage.tsx`** Runner Hosts page: per host, an editable "项目根目录"
  field + Save button calling a new `api.setProjectsRoot(hostId, value)` →
  cloud host-RPC. Field is read-only with a hint when `HostInfo.projectsRootLocked`
  is true (env-pinned).

## Data flow

```
host startup ──register{projectsRoot}──▶ cloud (hosts.projects_root) ──GET /hosts──▶ HostInfo.projectsRoot
                                                                                          │
                                                                          NewProject pre-fill: <root>/<slug>
                                                                          SettingsPage display

SettingsPage Save ──setProjectsRoot RPC──▶ cloud passthrough ──▶ host writes host.json, re-registers
                                                                          │
                                                          cloud updates row + broadcasts host update
```

## Relationship to the tilde fix

The tilde-expansion fix (`paths.ts` + routing all git-ops/fs-browse paths
through `resolveUserPath`) is a prerequisite already implemented in the working
tree. It guarantees that whatever path ends up stored — a `~/...` the user
typed, or a `~/cogni/...` default — resolves correctly on the host. This spec
builds the pre-fill + settings UX on top of it.

## Testing

- **runner-host:** projects-root resolution precedence (env > config > default)
  + tilde expansion; `set-projects-root` writes host.json and reflects on next
    read; env-pinned refusal; `gitInitIfMissing` creates missing parent dirs.
- **contract:** register schema accepts/omits `projectsRoot`;
  `hostRpcRequestSchema` discriminates `set-projects-root` and rejects wrong
  param shapes.
- **cloud:** migration is idempotent; register persists `projectsRoot`;
  `GET /hosts` returns it; `set-projects-root` passthrough updates the row.
- **ui:** NewProject pre-fill tracks name + host while clean, freezes once
  dirty; `sanitize` cases (slashes, spaces, unicode, empty); SettingsPage save
  path and env-locked read-only state.
```
