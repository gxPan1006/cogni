# File Upload (Agent Context Attachments) — Design

**Date:** 2026-05-20
**Status:** Approved, pre-implementation

## Goal

Let a user attach files in the chat composer and have the agent (Claude Code)
read them as context for that turn. Files land on the **runner-host's disk** in
the agent's working directory; the cloud is a pass-through relay and never
persists the bytes.

Scope decisions (locked):

- **Purpose:** files are agent context — they materialize into the agent's cwd
  so the runner reads them. Not a chat media gallery.
- **Surfaces:** both chat threads (`Conversation`/`Welcome` composer) and
  project tasks.
- **Types/size:** any file type, **≤ 50 MB** per file.

## Why this shape

This is the **inverse of the existing download pipeline** (`GET
/api/threads/:id/file` → `read-file` host RPC → base64 over WS). We reuse that
pattern's proven pieces: `pathUnder()`-style path confinement
(`packages/cloud/src/routes/artifact-file.ts:17`), the base64-over-JSON
convention (`packages/contract/src/host-protocol.ts:209-228`), and the
rpc-dispatcher add-a-case pattern (`packages/runner-host/src/rpc-dispatcher.ts`).

The 50 MB cap rules out a single WS JSON frame (base64 of 50 MB ≈ 67 MB in one
message). There is **no cloud object storage** (Postgres-only) and the host is
not directly reachable from a remote web client, so the only viable transport is
**HTTP upload to the cloud + chunked relay to the host over the existing WS**.

## Architecture

### Data flow

```
client (web/desktop)
  │  POST /api/threads/:id/uploads  (one HTTP request per file, raw body stream)
  ▼
cloud upload route
  │  reads request body in ~2MB chunks; never buffers the whole file
  │  upload-begin RPC ──▶ host (opens temp file, returns uploadId)
  │  upload-chunk RPC  ──▶ host (base64 chunk, seq; ack'd one at a time)  ×N
  │  upload-commit RPC ──▶ host (fsync, finalize, returns {relPath,size})
  ▼
returns { name, size, scopeKey } to client
  ...
client sends WS `send` frame WITH attachments: [{name, size}]
  ▼
cloud ChatDomain.persistAndDispatch
  │  persists message + attachmentsJson
  │  prepends dispatch preamble listing ./.cogni-uploads/<name>
  │  dispatch carries attachments
  ▼
host runner-manager
  │  materializes staged uploads into <cwd>/.cogni-uploads/
  ▼
claude-code adapter runs the turn; agent reads the files from cwd
```

### Where files land on the host

- **Staging (upload time):** `~/.cogni/uploads/<scopeKey>/<filename>` where
  `scopeKey` = `threadId` for chat or `taskId` for project tasks. Decouples
  upload timing from cwd existence — a project worktree may not exist yet when
  the user attaches.
- **Materialization (dispatch time):** the runner-manager copies staged files
  into `<cwd>/.cogni-uploads/`:
  - chat → `~/.cogni/threads/<threadId>/.cogni-uploads/`
    (cwd from `config.ts` `threadScratchDir`)
  - project task → `<worktree>/.cogni-uploads/`
- **git hygiene:** for project worktrees, add `.cogni-uploads/` to the
  worktree's `.git/info/exclude` so uploaded files don't appear in `git status`
  or get committed.

### How the agent learns about the files

`ChatDomain` / `ProjectDomain` prepend a preamble to the dispatch `message`:

```
[用户上传了以下文件，位于当前工作目录的 ./.cogni-uploads/ 下：
- .cogni-uploads/foo.pdf
- .cogni-uploads/bar.png]

<original user message>
```

The agent sees both the files on disk (in cwd) and an instruction pointing at
them.

### Transport: chunked upload RPC

Four new host-RPC methods (added to `HOST_RPC_METHODS`,
`hostRpcRequestSchema`, `hostRpcResponseSchema`):

| Method | Request payload | Response | Host behavior |
| --- | --- | --- | --- |
| `upload-begin` | `{ scope, fileName, declaredSize }` | `{ uploadId }` | sanitize `fileName` to basename; reject if `declaredSize > 50MB`; open temp file under `~/.cogni/uploads/<scopeKey>/.partial/<uploadId>` |
| `upload-chunk` | `{ uploadId, seq, dataBase64 }` | `{ received }` | decode, append; enforce **cumulative** ≤ 50 MB cap (abort + error if exceeded) |
| `upload-commit` | `{ uploadId }` | `{ relPath, size }` | fsync, rename into staging dir; de-dupe name collisions (`foo.pdf` → `foo-1.pdf`); return final name + byte size |
| `upload-abort` | `{ uploadId }` | `{ ok: true }` | delete temp file + handle |

`scope` is a discriminated union: `{ kind: "thread", threadId }` |
`{ kind: "task", projectId, taskId }`. The host resolves `scopeKey` and the
staging dir from it.

Host invariants (mirroring `fs-browse.ts` safety rules):

- filename is always reduced to `path.basename()`; reject empty / `.` / `..`.
- cap enforced both on `declaredSize` (fast reject) and cumulatively on bytes
  written (authoritative).
- temp files orphaned by a dropped connection are cleaned on a TTL sweep
  (best-effort; not load-bearing for correctness).

### Cloud upload endpoint

- `POST /api/threads/:id/uploads` and
  `POST /api/projects/:projectId/tasks/:taskId/uploads`.
- Auth + ownership check (same as the existing thread/file download routes in
  `client.ts:168-194`).
- Host-availability check first (reuse the dispatch-time check); 409 if the
  target host is offline.
- Streams the request body in ~2 MB chunks → `upload-begin` / `upload-chunk`
  (await each ack for backpressure) / `upload-commit`. On any error or client
  disconnect → `upload-abort`.
- Filename comes from the `X-Filename` header (URL-encoded) or a multipart
  field; size from `Content-Length` when present.
- Returns `{ name, size }` (the host's final, de-duped name).

### Persistence

- Migration: add nullable `attachmentsJson jsonb` to the `messages` table
  (`packages/cloud/src/db/schema.ts`). Stores `[{ name, size }]` — **metadata
  only, never bytes.**
- `appendMessage` accepts and stores attachments.
- `MessageView` (`domain.ts`) and the `cloudToClient` `message` frame
  (`protocol.ts:111-117`) gain an optional `attachments` field so the bubble
  can show chips after reload / on catch-up.

### Protocol changes (`@cogni/contract`)

- `attachmentSchema = { name: string, size: number }` (new, in a shared spot).
- `clientToCloud` `send` frame: add optional `attachments: attachmentSchema[]`.
- `cloudToHost` `dispatch`: add optional `attachments` (drives both the preamble
  and the materialization step).
- `cloudToClient` `message`: add optional `attachments`.
- `runner.ts`: the existing-but-unused `"attachments"` capability token is now
  meaningful — the claude-code adapter advertises it (it works because files are
  just on disk; no adapter-specific support needed).

## UI (`@cogni/ui`)

- **Composer** (`Composer.tsx:88-96`): enable the attach button; wire to a
  hidden `<input type="file" multiple>`. Add drag-drop on the composer surface.
- **Selected-file chips:** rendered above the textarea — name, human size,
  per-file upload **progress bar**, ✕ to remove. Uploads start immediately on
  selection.
- **Send gating:** the send button waits while any upload is in flight; a failed
  upload shows the chip in red with a **retry** affordance and does not block
  other files.
- **User bubble:** show attachment chips (📎 name) on the sent message, hydrated
  from `attachments` on the message view.
- **api client** (`api.ts`): add `uploadFile(scope, file, onProgress)` using
  **XHR** (browser/Tauri webview both support `xhr.upload.onprogress`; fetch
  lacks upload progress). Returns `{ name, size }`.

## Error handling

- Host offline at upload → 409, chip shows error, retry available.
- File > 50 MB → rejected at `upload-begin` (fast) and enforced cumulatively;
  chip shows "超过 50MB 上限".
- Client disconnect mid-upload → cloud sends `upload-abort`; host deletes temp.
- Commit failure (disk full, etc.) → error surfaced to the chip.
- Send attempted with an upload still pending → send button disabled, no frame
  sent.

## Testing

- **contract**: `attachmentSchema` round-trip; `send`/`dispatch`/`message`
  frames accept and validate `attachments`.
- **runner-host**: `upload-begin/chunk/commit/abort` happy path writes the file;
  filename sanitization (traversal rejected, basename only); 50 MB cap enforced
  cumulatively; name-collision de-dupe; materialization copies staged files into
  cwd and creates the `.git/info/exclude` entry for worktrees.
- **cloud**: upload route streams chunks and returns final name; host-offline →
  409; `ChatDomain` builds the correct dispatch preamble and persists
  `attachmentsJson`; `MessageView` round-trips attachments.
- **manual (per `MEMORY.md` stale-process checklist)**: attach a PDF + an image
  in the running web client, confirm chips + progress, send, confirm the agent
  reads them and that the bubble shows chips after reload.

## Out of scope (YAGNI)

- Chat media gallery / inline image preview of uploads (we only show chips).
- Storing bytes in the cloud / object storage.
- Resumable uploads across reconnects (single-shot per file; retry re-uploads).
- Multi-file single-request batching (one HTTP request per file is fine).
