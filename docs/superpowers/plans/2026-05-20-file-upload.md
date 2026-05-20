# File Upload (Agent Context Attachments) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user attach files in the composer; the bytes land on the runner-host's disk in the agent's working directory so Claude Code reads them as context for that turn.

**Architecture:** HTTP upload to the cloud (`POST /api/threads/:id/uploads`), which streams the body to the runner-host in base64 chunks over the existing WS (`upload-begin`/`upload-chunk`/`upload-commit` RPCs). The host stages files under `~/.cogni/uploads/<threadId>/` and the runner-manager copies this turn's files into `<cwd>/.cogni-uploads/` at dispatch. A short preamble prepended to the dispatch message points the agent at them. The cloud never persists bytes; only `[{name,size}]` metadata is stored on the message.

**Tech Stack:** TypeScript (ESM, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`), zod (`@cogni/contract`), Hono + `@hono/node-ws` (cloud), drizzle + pglite tests (cloud), Node fs/promises (host), React 19 (`@cogni/ui`), vitest.

**Universal scope key = `threadId`.** Every dispatch (chat or project task) carries a `threadId`; project-task dispatches use the task's `executionThreadId`. Staging and materialization are keyed by that single id, so chat and tasks share one mechanism.

**Run the full check after each task:** `pnpm build && pnpm test` (and `pnpm typecheck` before any commit that touches types).

---

## File Structure

**Created:**
- `packages/runner-host/src/uploads.ts` — `UploadStore` (begin/chunk/commit/abort, staging, cap, sanitize, dedupe) + `materializeUploads()`.
- `packages/runner-host/src/uploads.test.ts`
- `packages/ui/src/hooks/useUploads.ts` — composer upload state (select → upload → chips/progress → results).

**Modified:**
- `packages/contract/src/host-protocol.ts` — 4 upload RPC payload schemas + union/enum/array entries.
- `packages/contract/src/protocol.ts` — `attachmentSchema`; extend `send`, `dispatch`, `message` frames.
- `packages/contract/src/host-protocol.test.ts` / `protocol.test.ts` (create if absent) — schema round-trips.
- `packages/runner-host/src/rpc-dispatcher.ts` — `RpcDeps` + `routeRpc` arms.
- `packages/runner-host/src/main.ts` — construct `UploadStore`, wire 4 handlers into `dispatchHostRpc`.
- `packages/runner-host/src/runner-manager.ts` — `DispatchInput.attachments`, materialize before `handle.send`.
- `packages/cloud/src/db/schema.ts` — `messages.attachmentsJson jsonb`.
- `packages/cloud/src/db/threads.ts` — `appendMessage` accepts/stores attachments; `toMessageView` maps.
- `packages/contract/src/domain.ts` — `MessageView.attachments`.
- `packages/cloud/src/routes/client.ts` — `POST /api/threads/:id/uploads` (+ task variant in Task 11); pass `msg.attachments` to chat domain.
- `packages/cloud/src/domains/chat.ts` — thread attachments through `handleClientSend` → `persistAndDispatch` → preamble + dispatch + broadcast.
- `packages/cloud/src/domains/chat.test.ts` — preamble + persistence assertions.
- `packages/ui/src/transport/api.ts` — `uploadFile(threadId, file, onProgress)`.
- `packages/ui/src/transport/ws-client.ts` — `send` carries attachments.
- `packages/ui/src/hooks/useThreadStream.ts` — `send(text, attachments?)`.
- `packages/ui/src/components/Composer.tsx` + `composer.css` — attach button, hidden file input, drag-drop, chips, progress, send gating.
- `packages/ui/src/components/Conversation.tsx`, `Welcome.tsx` — wire `useUploads` into Composer.
- `packages/ui/src/components/ChatBlocks.tsx` — render attachment chips on user bubbles.

---

## Task 1: Contract — attachment schema + upload RPC methods

**Files:**
- Modify: `packages/contract/src/host-protocol.ts`
- Modify: `packages/contract/src/protocol.ts`
- Test: `packages/contract/src/upload-protocol.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/contract/src/upload-protocol.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  hostRpcRequestSchema,
  hostRpcResponseSchema,
  HOST_RPC_METHODS,
  clientToCloudSchema,
  cloudToHostSchema,
  cloudToClientSchema,
  attachmentSchema,
} from "./index.js";

describe("upload protocol", () => {
  it("attachmentSchema accepts {name,size}", () => {
    expect(attachmentSchema.parse({ name: "a.pdf", size: 12 })).toEqual({ name: "a.pdf", size: 12 });
  });

  it("registers the 4 upload RPC methods", () => {
    for (const m of ["upload-begin", "upload-chunk", "upload-commit", "upload-abort"] as const) {
      expect(HOST_RPC_METHODS).toContain(m);
    }
  });

  it("validates an upload-begin request and response", () => {
    const req = hostRpcRequestSchema.parse({
      method: "upload-begin",
      params: { scope: { kind: "thread", threadId: "t1" }, fileName: "a.pdf", declaredSize: 10 },
    });
    expect(req.method).toBe("upload-begin");
    const ok = hostRpcResponseSchema.parse({
      ok: true, method: "upload-begin", result: { uploadId: "u1" },
    });
    expect(ok.ok).toBe(true);
  });

  it("validates upload-chunk and upload-commit", () => {
    expect(hostRpcRequestSchema.parse({
      method: "upload-chunk", params: { uploadId: "u1", seq: 0, dataBase64: "AA==" },
    }).method).toBe("upload-chunk");
    expect(hostRpcResponseSchema.parse({
      ok: true, method: "upload-commit", result: { relPath: ".cogni-uploads/a.pdf", name: "a.pdf", size: 10 },
    }).ok).toBe(true);
  });

  it("carries attachments on send / dispatch / message frames", () => {
    const att = [{ name: "a.pdf", size: 10 }];
    expect(clientToCloudSchema.parse({ t: "send", threadId: "t1", text: "hi", attachments: att })).toBeTruthy();
    expect(cloudToHostSchema.parse({
      t: "dispatch", sessionId: "s", threadId: "t1", adapter: "claude-code",
      runnerSessionId: null, message: "hi", attachments: att,
    })).toBeTruthy();
    expect(cloudToClientSchema.parse({
      t: "message", threadId: "t1", messageId: "m", role: "user",
      content: "hi", createdAt: "now", attachments: att,
    })).toBeTruthy();
  });

  it("send / dispatch / message still parse without attachments", () => {
    expect(clientToCloudSchema.parse({ t: "send", threadId: "t1", text: "hi" })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/contract/src/upload-protocol.test.ts`
Expected: FAIL — `attachmentSchema` is not exported / unknown keys rejected.

- [ ] **Step 3: Add the upload payload schemas in `host-protocol.ts`**

Insert after the `read-file` block (after line 228, before the `─── Discriminated unions` divider):

```ts
// ─── File upload (agent-context attachments) ────────────────────────────────
// Inbound counterpart to read-file. The cloud streams an HTTP upload to the
// host in base64 chunks; the host stages the file under
// ~/.cogni/uploads/<threadId>/ and the runner-manager copies this turn's files
// into <cwd>/.cogni-uploads/ at dispatch. 50MB cap enforced cumulatively host-side.

export const uploadScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: z.string() }),
]);
export type UploadScope = z.infer<typeof uploadScopeSchema>;

export const uploadBeginRequestSchema = z.object({
  scope: uploadScopeSchema,
  /** Original client filename; host reduces to basename + de-dupes. */
  fileName: z.string(),
  /** Client-declared size for a fast pre-check; host enforces the real cap on bytes written. */
  declaredSize: z.number().int().min(0),
});
export type UploadBeginRequest = z.infer<typeof uploadBeginRequestSchema>;

export const uploadBeginResponseSchema = z.object({ uploadId: z.string() });
export type UploadBeginResponse = z.infer<typeof uploadBeginResponseSchema>;

export const uploadChunkRequestSchema = z.object({
  uploadId: z.string(),
  seq: z.number().int().min(0),
  /** One chunk of the file, base64-encoded (binary-safe over the JSON WS frame). */
  dataBase64: z.string(),
});
export type UploadChunkRequest = z.infer<typeof uploadChunkRequestSchema>;

export const uploadChunkResponseSchema = z.object({ received: z.number().int().min(0) });
export type UploadChunkResponse = z.infer<typeof uploadChunkResponseSchema>;

export const uploadCommitRequestSchema = z.object({ uploadId: z.string() });
export type UploadCommitRequest = z.infer<typeof uploadCommitRequestSchema>;

export const uploadCommitResponseSchema = z.object({
  /** Path relative to the agent cwd, e.g. ".cogni-uploads/foo.pdf". */
  relPath: z.string(),
  /** Final (possibly de-duped) basename, e.g. "foo-1.pdf". */
  name: z.string(),
  size: z.number().int().min(0),
});
export type UploadCommitResponse = z.infer<typeof uploadCommitResponseSchema>;

export const uploadAbortRequestSchema = z.object({ uploadId: z.string() });
export type UploadAbortRequest = z.infer<typeof uploadAbortRequestSchema>;

export const uploadAbortResponseSchema = z.object({ ok: z.literal(true) });
export type UploadAbortResponse = z.infer<typeof uploadAbortResponseSchema>;
```

- [ ] **Step 4: Register the 4 methods in the union, enum, response union, and `HOST_RPC_METHODS`**

In `hostRpcRequestSchema` (the `z.discriminatedUnion`), add after the `read-file` arm:

```ts
  z.object({ method: z.literal("upload-begin"), params: uploadBeginRequestSchema }),
  z.object({ method: z.literal("upload-chunk"), params: uploadChunkRequestSchema }),
  z.object({ method: z.literal("upload-commit"), params: uploadCommitRequestSchema }),
  z.object({ method: z.literal("upload-abort"), params: uploadAbortRequestSchema }),
```

In `hostRpcMethodSchema` (`z.enum([...])`) add the 4 literals after `"read-file"`:

```ts
  "upload-begin",
  "upload-chunk",
  "upload-commit",
  "upload-abort",
```

In `hostRpcResponseSchema` (`z.union`), add after the `read-file` success arm:

```ts
  z.object({ ok: z.literal(true), method: z.literal("upload-begin"), result: uploadBeginResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("upload-chunk"), result: uploadChunkResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("upload-commit"), result: uploadCommitResponseSchema }),
  z.object({ ok: z.literal(true), method: z.literal("upload-abort"), result: uploadAbortResponseSchema }),
```

In `HOST_RPC_METHODS` (the `as const` array) add the 4 literals after `"read-file"`:

```ts
  "upload-begin",
  "upload-chunk",
  "upload-commit",
  "upload-abort",
```

- [ ] **Step 5: Add `attachmentSchema` and extend the three frames in `protocol.ts`**

At the top of `protocol.ts`, after the `sessionStatusSchema` block (after line 12), add:

```ts
/** Lightweight attachment metadata carried on send/dispatch/message frames. */
export const attachmentSchema = z.object({
  name: z.string(),
  size: z.number().int().min(0),
});
export type Attachment = z.infer<typeof attachmentSchema>;
```

In `clientToCloudSchema`, change the `send` arm (line 84) to:

```ts
  z.object({ t: z.literal("send"), threadId: z.string(), text: z.string(), attachments: z.array(attachmentSchema).optional() }),
```

In `cloudToHostSchema`'s `dispatch` arm, add an `attachments` field (after `appendSystemPrompt`, before the closing `})` at line 68):

```ts
    /**
     * Files the user attached this turn. The host copies them from its staging
     * dir into <cwd>/.cogni-uploads/ before running, and the cloud has already
     * prepended a preamble to `message` pointing at them. Optional/absent for
     * turns with no attachments.
     */
    attachments: z.array(attachmentSchema).optional(),
```

In `cloudToClientSchema`'s `message` arm (lines 110-117), add after `createdAt`:

```ts
    attachments: z.array(attachmentSchema).optional(),
```

Confirm `attachmentSchema` is re-exported: `packages/contract/src/index.ts` should `export * from "./protocol.js"` already (it does for the other frames). No change needed if so; otherwise add the export.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run packages/contract/src/upload-protocol.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Build + commit**

```bash
pnpm build
git add packages/contract/src
git commit -m "feat(contract): attachment schema + upload RPC methods"
```

---

## Task 2: Host — UploadStore + materialize

**Files:**
- Create: `packages/runner-host/src/uploads.ts`
- Test: `packages/runner-host/src/uploads.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/runner-host/src/uploads.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile as fsReadFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UploadStore, materializeUploads, MAX_UPLOAD_BYTES } from "./uploads.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cogni-up-"));
  process.env.COGNI_HOME = home;
});
afterEach(async () => {
  delete process.env.COGNI_HOME;
  await rm(home, { recursive: true, force: true });
});

function b64(s: string) { return Buffer.from(s).toString("base64"); }

describe("UploadStore", () => {
  it("begin → chunk → commit writes a staged file and returns relPath", async () => {
    const store = new UploadStore();
    const { uploadId } = await store.begin({ scope: { kind: "thread", threadId: "t1" }, fileName: "hello.txt", declaredSize: 11 });
    await store.chunk({ uploadId, seq: 0, dataBase64: b64("hello ") });
    await store.chunk({ uploadId, seq: 1, dataBase64: b64("world") });
    const res = await store.commit({ uploadId });
    expect(res.relPath).toBe(".cogni-uploads/hello.txt");
    expect(res.name).toBe("hello.txt");
    expect(res.size).toBe(11);
    const staged = join(home, "uploads", "t1", "hello.txt");
    expect((await fsReadFile(staged, "utf8"))).toBe("hello world");
  });

  it("sanitizes a traversal filename to its basename", async () => {
    const store = new UploadStore();
    const { uploadId } = await store.begin({ scope: { kind: "thread", threadId: "t1" }, fileName: "../../etc/passwd", declaredSize: 1 });
    await store.chunk({ uploadId, seq: 0, dataBase64: b64("x") });
    const res = await store.commit({ uploadId });
    expect(res.name).toBe("passwd");
    expect(res.relPath).toBe(".cogni-uploads/passwd");
  });

  it("de-dupes a colliding name", async () => {
    const store = new UploadStore();
    for (const expected of ["a.txt", "a-1.txt", "a-2.txt"]) {
      const { uploadId } = await store.begin({ scope: { kind: "thread", threadId: "t1" }, fileName: "a.txt", declaredSize: 1 });
      await store.chunk({ uploadId, seq: 0, dataBase64: b64("x") });
      expect((await store.commit({ uploadId })).name).toBe(expected);
    }
  });

  it("rejects begin when declaredSize exceeds the cap", async () => {
    const store = new UploadStore();
    await expect(store.begin({ scope: { kind: "thread", threadId: "t1" }, fileName: "big", declaredSize: MAX_UPLOAD_BYTES + 1 }))
      .rejects.toMatchObject({ code: "upload-too-large" });
  });

  it("aborts when cumulative bytes exceed the cap", async () => {
    const store = new UploadStore();
    const { uploadId } = await store.begin({ scope: { kind: "thread", threadId: "t1" }, fileName: "big", declaredSize: 0 });
    const oneMb = "A".repeat(1024 * 1024);
    await expect((async () => {
      for (let seq = 0; seq < 60; seq++) await store.chunk({ uploadId, seq, dataBase64: b64(oneMb) });
    })()).rejects.toMatchObject({ code: "upload-too-large" });
  });

  it("abort removes the temp file", async () => {
    const store = new UploadStore();
    const { uploadId } = await store.begin({ scope: { kind: "thread", threadId: "t1" }, fileName: "x.txt", declaredSize: 1 });
    await store.chunk({ uploadId, seq: 0, dataBase64: b64("x") });
    const r = await store.abort({ uploadId });
    expect(r.ok).toBe(true);
    await expect(store.chunk({ uploadId, seq: 1, dataBase64: b64("y") })).rejects.toMatchObject({ code: "upload-not-found" });
  });
});

describe("materializeUploads", () => {
  it("copies named staged files into <cwd>/.cogni-uploads", async () => {
    const stageDir = join(home, "uploads", "t1");
    await mkdir(stageDir, { recursive: true });
    await writeFile(join(stageDir, "foo.txt"), "hi");
    const cwd = await mkdtemp(join(tmpdir(), "cogni-cwd-"));
    await materializeUploads("t1", [{ name: "foo.txt" }], cwd);
    expect(await fsReadFile(join(cwd, ".cogni-uploads", "foo.txt"), "utf8")).toBe("hi");
    await rm(cwd, { recursive: true, force: true });
  });

  it("adds .cogni-uploads to .git/info/exclude when cwd is a git worktree", async () => {
    const stageDir = join(home, "uploads", "t1");
    await mkdir(stageDir, { recursive: true });
    await writeFile(join(stageDir, "foo.txt"), "hi");
    const cwd = await mkdtemp(join(tmpdir(), "cogni-wt-"));
    await mkdir(join(cwd, ".git", "info"), { recursive: true });
    await materializeUploads("t1", [{ name: "foo.txt" }], cwd);
    expect(await fsReadFile(join(cwd, ".git", "info", "exclude"), "utf8")).toContain(".cogni-uploads/");
    await rm(cwd, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/runner-host/src/uploads.test.ts`
Expected: FAIL — `./uploads.js` does not exist.

- [ ] **Step 3: Implement `uploads.ts`**

Create `packages/runner-host/src/uploads.ts`:

```ts
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
    // touch the file
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

function sanitizeName(name: string): string {
  const base = basename(name).replace(/[ -/\\]/g, "").trim();
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
  const excludePath = join(cwd, ".git", "info", "exclude");
  try {
    const current = await readFile(excludePath, "utf8");
    if (current.includes(`${UPLOAD_DIRNAME}/`)) return;
    await appendFile(excludePath, `\n${UPLOAD_DIRNAME}/\n`);
  } catch {
    // not a worktree (no .git/info/exclude) → nothing to exclude
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/runner-host/src/uploads.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/runner-host/src/uploads.ts packages/runner-host/src/uploads.test.ts
git commit -m "feat(runner-host): upload staging store + cwd materialization"
```

---

## Task 3: Host — wire upload handlers into the RPC dispatcher

**Files:**
- Modify: `packages/runner-host/src/rpc-dispatcher.ts`
- Modify: `packages/runner-host/src/main.ts`
- Test: `packages/runner-host/src/rpc-dispatcher.test.ts` (create if absent; otherwise add cases)

- [ ] **Step 1: Write the failing test**

Create/extend `packages/runner-host/src/rpc-dispatcher.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { dispatchHostRpc, type RpcDeps } from "./rpc-dispatcher.js";
import { UploadError } from "./uploads.js";

function deps(over: Partial<RpcDeps>): RpcDeps {
  const stub = vi.fn();
  return {
    gitInitIfMissing: stub, gitWorktreeCreate: stub, gitWorktreeRemove: stub,
    gitMergeToMain: stub, gitPushToRemote: stub, gitTestsRun: stub,
    gitDiffSnapshot: stub, fsBrowse: stub, readFile: stub, generateThreadTitle: stub,
    uploadBegin: stub, uploadChunk: stub, uploadCommit: stub, uploadAbort: stub,
    ...over,
  } as RpcDeps;
}

describe("dispatchHostRpc upload arms", () => {
  it("routes upload-begin to deps.uploadBegin", async () => {
    const uploadBegin = vi.fn().mockResolvedValue({ uploadId: "u1" });
    const resp = await dispatchHostRpc(
      { method: "upload-begin", params: { scope: { kind: "thread", threadId: "t1" }, fileName: "a", declaredSize: 1 } },
      deps({ uploadBegin }),
    );
    expect(uploadBegin).toHaveBeenCalled();
    expect(resp).toMatchObject({ ok: true, method: "upload-begin", result: { uploadId: "u1" } });
  });

  it("maps an UploadError to ok:false with its code", async () => {
    const uploadCommit = vi.fn().mockRejectedValue(new UploadError("upload-not-found", "nope"));
    const resp = await dispatchHostRpc(
      { method: "upload-commit", params: { uploadId: "x" } },
      deps({ uploadCommit }),
    );
    expect(resp).toMatchObject({ ok: false, method: "upload-commit", error: { code: "upload-not-found" } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/runner-host/src/rpc-dispatcher.test.ts`
Expected: FAIL — `uploadBegin` not on `RpcDeps`; `upload-begin` not handled in `routeRpc`.

- [ ] **Step 3: Extend `rpc-dispatcher.ts`**

Add to the type imports from `@cogni/contract` (inside the existing import block):

```ts
  type UploadBeginRequest,
  type UploadBeginResponse,
  type UploadChunkRequest,
  type UploadChunkResponse,
  type UploadCommitRequest,
  type UploadCommitResponse,
  type UploadAbortRequest,
  type UploadAbortResponse,
```

Add the `UploadError` import next to the other error imports:

```ts
import { UploadError } from "./uploads.js";
```

Add to the `RpcDeps` interface (after `generateThreadTitle`):

```ts
  uploadBegin: (req: UploadBeginRequest) => Promise<UploadBeginResponse>;
  uploadChunk: (req: UploadChunkRequest) => Promise<UploadChunkResponse>;
  uploadCommit: (req: UploadCommitRequest) => Promise<UploadCommitResponse>;
  uploadAbort: (req: UploadAbortRequest) => Promise<UploadAbortResponse>;
```

Add to the `routeRpc` switch (after the `generate-thread-title` case):

```ts
    case "upload-begin":
      return { ok: true, method: frame.method, result: await deps.uploadBegin(frame.params) };
    case "upload-chunk":
      return { ok: true, method: frame.method, result: await deps.uploadChunk(frame.params) };
    case "upload-commit":
      return { ok: true, method: frame.method, result: await deps.uploadCommit(frame.params) };
    case "upload-abort":
      return { ok: true, method: frame.method, result: await deps.uploadAbort(frame.params) };
```

Add `UploadError` to the `errorPayload` instanceof check:

```ts
  if (e instanceof GitOpError || e instanceof FsBrowseError || e instanceof GenerateTitleError || e instanceof UploadError) {
    return { code: e.code, message: e.message };
  }
```

- [ ] **Step 4: Wire the store in `main.ts`**

Add import:

```ts
import { UploadStore } from "./uploads.js";
```

Before `connectToCloud(...)` add:

```ts
  const uploads = new UploadStore();
```

Add the 4 handlers to the `dispatchHostRpc(req, { ... })` object (after `generateThreadTitle,`):

```ts
      uploadBegin: (r) => uploads.begin(r),
      uploadChunk: (r) => uploads.chunk(r),
      uploadCommit: (r) => uploads.commit(r),
      uploadAbort: (r) => uploads.abort(r),
```

- [ ] **Step 5: Run test + build**

Run: `pnpm vitest run packages/runner-host/src/rpc-dispatcher.test.ts`
Expected: PASS.
Run: `pnpm build`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/runner-host/src/rpc-dispatcher.ts packages/runner-host/src/rpc-dispatcher.test.ts packages/runner-host/src/main.ts
git commit -m "feat(runner-host): wire upload RPC handlers into dispatcher"
```

---

## Task 4: Host — materialize attachments at dispatch

**Files:**
- Modify: `packages/runner-host/src/runner-manager.ts`
- Test: `packages/runner-host/src/runner-manager.test.ts` (create if absent; otherwise add a case)

- [ ] **Step 1: Write the failing test**

Create/extend `packages/runner-host/src/runner-manager.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerManager } from "./runner-manager.js";
import type { RunnerAdapter, RunnerSessionHandle } from "@cogni/contract";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "cogni-rm-")); process.env.COGNI_HOME = home; });
afterEach(async () => { delete process.env.COGNI_HOME; await rm(home, { recursive: true, force: true }); });

function fakeAdapter(): RunnerAdapter {
  const handle: RunnerSessionHandle = {
    async *send() { yield { type: "done" } as const; },
    async close() {},
  };
  return {
    id: "claude-code",
    capabilities: ["streaming"],
    async startSession() { return handle; },
    async resumeSession() { return handle; },
  } as unknown as RunnerAdapter;
}

describe("RunnerManager attachment materialization", () => {
  it("copies staged attachments into <cwd>/.cogni-uploads before the turn", async () => {
    const stage = join(home, "uploads", "t1");
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, "foo.txt"), "hi");

    const mgr = new RunnerManager();
    mgr.register(fakeAdapter());
    const events: unknown[] = [];
    await mgr.dispatch(
      { sessionId: "s1", threadId: "t1", adapter: "claude-code", runnerSessionId: null, message: "go", attachments: [{ name: "foo.txt" }] },
      (e) => events.push(e),
    );
    const cwd = join(home, "threads", "t1");
    expect(await readFile(join(cwd, ".cogni-uploads", "foo.txt"), "utf8")).toBe("hi");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/runner-host/src/runner-manager.test.ts`
Expected: FAIL — `attachments` not on `DispatchInput`; file not copied.

- [ ] **Step 3: Add `attachments` to `DispatchInput` + materialize**

In `runner-manager.ts`, add the import:

```ts
import { materializeUploads } from "./uploads.js";
```

Add to the `DispatchInput` interface (after `appendSystemPrompt?`):

```ts
  /**
   * Files the user attached this turn. Copied from the host staging dir into
   * <cwd>/.cogni-uploads/ before the runner starts. Absent for turns with none.
   */
  attachments?: { name: string }[];
```

In `dispatch()`, after the cwd is resolved and the chat-scratch mkdir runs (after line 74, before the `opts` block), add:

```ts
    if (input.attachments && input.attachments.length > 0) {
      await materializeUploads(input.threadId, input.attachments, cwd);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/runner-host/src/runner-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the dispatch handler forwards `attachments`**

The host's dispatch entry point (in `registry.ts` / wherever the `"dispatch"` cloud frame is turned into a `RunnerManager.dispatch` call) must pass `attachments: frame.attachments`. Find it:

Run: `grep -rn "manager.dispatch\|\.dispatch(" packages/runner-host/src/registry.ts`

Add `attachments: msg.attachments` (or the local frame variable name) to the object passed to `dispatch`. If the call spreads the frame, no change is needed — verify by reading the call site.

- [ ] **Step 6: Build + commit**

```bash
pnpm build
git add packages/runner-host/src/runner-manager.ts packages/runner-host/src/runner-manager.test.ts packages/runner-host/src/registry.ts
git commit -m "feat(runner-host): materialize attachments into agent cwd at dispatch"
```

---

## Task 5: Cloud — persist attachment metadata on messages

**Files:**
- Modify: `packages/cloud/src/db/schema.ts:92-98`
- Modify: `packages/cloud/src/db/threads.ts:95-104` (`appendMessage`, `toMessageView`)
- Modify: `packages/contract/src/domain.ts:17-23` (`MessageView`)
- Test: `packages/cloud/src/db/threads.test.ts` (create if absent; otherwise add a case)

- [ ] **Step 1: Write the failing test**

Create/extend `packages/cloud/src/db/threads.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../test-helpers/db.js"; // existing pglite helper
import { createThread, appendMessage, getThreadDetail } from "./threads.js";

describe("appendMessage attachments", () => {
  it("stores and returns attachment metadata", async () => {
    const db = await makeTestDb();
    const thread = await createThread(db, { userId: "u1", tenantId: "te1" });
    const msg = await appendMessage(db, {
      threadId: thread.id, role: "user", content: "see file",
      attachments: [{ name: "a.pdf", size: 12 }],
    });
    expect(msg.attachments).toEqual([{ name: "a.pdf", size: 12 }]);
    const detail = await getThreadDetail(db, thread.id);
    expect(detail?.messages[0]?.attachments).toEqual([{ name: "a.pdf", size: 12 }]);
  });

  it("omits attachments when none were provided", async () => {
    const db = await makeTestDb();
    const thread = await createThread(db, { userId: "u1", tenantId: "te1" });
    const msg = await appendMessage(db, { threadId: thread.id, role: "user", content: "hi" });
    expect(msg.attachments).toBeUndefined();
  });
});
```

> If `makeTestDb` lives at a different path, copy the import used by an existing `packages/cloud/src/**/*.test.ts` (grep: `grep -rn "pglite\|drizzle(" packages/cloud/src/**/*.test.ts | head`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cloud/src/db/threads.test.ts`
Expected: FAIL — `attachments` is not accepted/returned.

- [ ] **Step 3: Add the column to `schema.ts`**

Add to the `messages` table (after `createdAt`, keeping the `import { jsonb }` — it is already imported, used by `events.payloadJson`):

```ts
  attachmentsJson: jsonb("attachments_json"),
```

- [ ] **Step 4: Extend `MessageView` in `domain.ts`**

```ts
export interface MessageView {
  id: string;
  threadId: string;
  role: Role;
  content: string;
  createdAt: string;
  attachments?: { name: string; size: number }[];
}
```

- [ ] **Step 5: Update `appendMessage` + `toMessageView` in `threads.ts`**

Change `appendMessage`'s input + insert:

```ts
export async function appendMessage(
  db: AnyDb,
  input: { threadId: string; role: Role; content: string; attachments?: { name: string; size: number }[] },
): Promise<MessageView> {
  const [row] = await db
    .insert(messages)
    .values({
      threadId: input.threadId,
      role: input.role,
      content: input.content,
      attachmentsJson: input.attachments && input.attachments.length > 0 ? input.attachments : null,
    })
    .returning();
  return toMessageView(row!);
}
```

Find `toMessageView` (grep: `grep -n "function toMessageView" packages/cloud/src/db/threads.ts`) and add the mapping. It currently returns `{ id, threadId, role, content, createdAt }`; add:

```ts
    ...(row.attachmentsJson ? { attachments: row.attachmentsJson as { name: string; size: number }[] } : {}),
```

- [ ] **Step 6: Run test + push schema to Neon**

Run: `pnpm vitest run packages/cloud/src/db/threads.test.ts`
Expected: PASS.
Run (against the real DB, once): `pnpm build && pnpm --filter @cogni/cloud exec drizzle-kit push`
Expected: drizzle adds the `attachments_json` column.

- [ ] **Step 7: Commit**

```bash
git add packages/cloud/src/db/schema.ts packages/cloud/src/db/threads.ts packages/contract/src/domain.ts packages/cloud/src/db/threads.test.ts
git commit -m "feat(cloud): persist attachment metadata on messages"
```

---

## Task 6: Cloud — chat upload endpoint (streaming relay)

**Files:**
- Create: `packages/cloud/src/routes/upload.ts` (relay helper, unit-testable)
- Modify: `packages/cloud/src/routes/client.ts` (mount `POST /api/threads/:id/uploads`)
- Test: `packages/cloud/src/routes/upload.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/cloud/src/routes/upload.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { relayUpload } from "./upload.js";
import type { HostRpcResponse } from "@cogni/contract";

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) { if (i < chunks.length) c.enqueue(chunks[i++]!); else c.close(); },
  });
}

describe("relayUpload", () => {
  it("begins, chunks, and commits, returning the host's final name/size", async () => {
    const calls: string[] = [];
    const sendRpc = vi.fn(async (_hostId, req): Promise<HostRpcResponse> => {
      calls.push(req.method);
      if (req.method === "upload-begin") return { ok: true, method: "upload-begin", result: { uploadId: "u1" } };
      if (req.method === "upload-chunk") return { ok: true, method: "upload-chunk", result: { received: 1 } };
      if (req.method === "upload-commit") return { ok: true, method: "upload-commit", result: { relPath: ".cogni-uploads/a.txt", name: "a.txt", size: 5 } };
      return { ok: true, method: "upload-abort", result: { ok: true } };
    });
    const res = await relayUpload({
      hostId: "h1", threadId: "t1", fileName: "a.txt", declaredSize: 5,
      body: streamOf(new Uint8Array([104, 101, 108, 108, 111])),
      sendRpc, chunkBytes: 1024 * 1024,
    });
    expect(res).toEqual({ name: "a.txt", size: 5 });
    expect(calls[0]).toBe("upload-begin");
    expect(calls.at(-1)).toBe("upload-commit");
  });

  it("aborts on a host error mid-stream and throws", async () => {
    const sendRpc = vi.fn(async (_hostId, req): Promise<HostRpcResponse> => {
      if (req.method === "upload-begin") return { ok: true, method: "upload-begin", result: { uploadId: "u1" } };
      if (req.method === "upload-chunk") return { ok: false, method: "upload-chunk", error: { code: "upload-too-large", message: "x" } };
      return { ok: true, method: "upload-abort", result: { ok: true } };
    });
    await expect(relayUpload({
      hostId: "h1", threadId: "t1", fileName: "a.txt", declaredSize: 5,
      body: streamOf(new Uint8Array([1, 2, 3])), sendRpc, chunkBytes: 1,
    })).rejects.toThrow(/upload-too-large/);
    expect(sendRpc).toHaveBeenCalledWith("h1", { method: "upload-abort", params: { uploadId: "u1" } }, expect.anything());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cloud/src/routes/upload.test.ts`
Expected: FAIL — `./upload.js` does not exist.

- [ ] **Step 3: Implement `upload.ts`**

Create `packages/cloud/src/routes/upload.ts`:

```ts
/**
 * Cloud → host streaming upload relay. Reads an HTTP request body chunk by
 * chunk and forwards it to the host as base64 upload-chunk RPCs, awaiting each
 * ack for backpressure. Never buffers the whole file. On any error or empty
 * host, sends upload-abort and rethrows so the route can map to a 4xx/5xx.
 */
import type { HostRpcRequest, HostRpcResponse } from "@cogni/contract";

export type SendRpc = (
  hostId: string,
  request: HostRpcRequest,
  opts?: { timeoutMs?: number },
) => Promise<HostRpcResponse>;

const RPC_TIMEOUT_MS = 60_000;

export async function relayUpload(args: {
  hostId: string;
  threadId: string;
  fileName: string;
  declaredSize: number;
  body: ReadableStream<Uint8Array>;
  sendRpc: SendRpc;
  /** Flush threshold; ~2MB in production. */
  chunkBytes: number;
}): Promise<{ name: string; size: number }> {
  const { hostId, threadId, fileName, declaredSize, body, sendRpc, chunkBytes } = args;

  const begin = await sendRpc(
    hostId,
    { method: "upload-begin", params: { scope: { kind: "thread", threadId }, fileName, declaredSize } },
    { timeoutMs: RPC_TIMEOUT_MS },
  );
  if (!begin.ok || begin.method !== "upload-begin") {
    throw new Error(`upload-begin failed: ${begin.ok ? "wrong method" : begin.error.code + " " + begin.error.message}`);
  }
  const uploadId = begin.result.uploadId;

  const abort = async () => {
    await sendRpc(hostId, { method: "upload-abort", params: { uploadId } }, { timeoutMs: RPC_TIMEOUT_MS }).catch(() => undefined);
  };

  let seq = 0;
  let buffered: Uint8Array[] = [];
  let bufferedLen = 0;
  const reader = body.getReader();

  const flush = async () => {
    if (bufferedLen === 0) return;
    const merged = Buffer.concat(buffered.map((u) => Buffer.from(u)), bufferedLen);
    buffered = [];
    bufferedLen = 0;
    const resp = await sendRpc(
      hostId,
      { method: "upload-chunk", params: { uploadId, seq: seq++, dataBase64: merged.toString("base64") } },
      { timeoutMs: RPC_TIMEOUT_MS },
    );
    if (!resp.ok) {
      // ok:false is the single error branch of HostRpcResponse — `error` narrows here.
      throw new Error(`upload-chunk failed: ${resp.error.code}: ${resp.error.message}`);
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        buffered.push(value);
        bufferedLen += value.length;
        if (bufferedLen >= chunkBytes) await flush();
      }
    }
    await flush();
    const commit = await sendRpc(
      hostId,
      { method: "upload-commit", params: { uploadId } },
      { timeoutMs: RPC_TIMEOUT_MS },
    );
    if (!commit.ok || commit.method !== "upload-commit") {
      throw new Error(`upload-commit failed`);
    }
    return { name: commit.result.name, size: commit.result.size };
  } catch (err) {
    await abort();
    throw err;
  }
}
```

> `HostRpcResponse` is a union whose only `ok:false` member carries `error: { code, message }`, so `!resp.ok` narrows `resp.error` cleanly. If `pnpm typecheck` complains, the union shape changed — re-check `host-protocol.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/cloud/src/routes/upload.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Mount the route in `client.ts`**

Add imports at the top of `client.ts`:

```ts
import { relayUpload } from "./upload.js";
import { sendHostRpc } from "./host-ws.js";
```

Add the route next to the other thread file routes (after the `GET /api/threads/:id/file` block, before the `// --- WS` divider at line 195). `c.req.raw.body` is the web `ReadableStream`; filename arrives URL-encoded in `X-Filename`:

```ts
  // Upload a file as agent context for a chat thread. Streams the body to the
  // thread's host (the latest runner session's host) and stages it under
  // ~/.cogni/uploads/<threadId>/. Returns the host's final (de-duped) name+size;
  // the client then references it in the next `send` frame's `attachments`.
  app.post("/api/threads/:id/uploads", async (c) => {
    const { userId } = c.get("claims");
    const id = c.req.param("id");
    if (!(await threadBelongsToUser(deps.db, id, userId))) return c.json({ error: "not found" }, 404);

    const fileName = decodeURIComponent(c.req.header("X-Filename") ?? "").trim() || "upload";
    const declaredSize = Number(c.req.header("Content-Length") ?? 0) || 0;

    // Pick the host the way dispatch does: the thread's latest session host if
    // online, else any online host for the user (new thread).
    const session = await getLatestSessionForThread(deps.db, id);
    const online = deps.hosts.getOnlineHostsForUser(userId);
    const hostId = online.find((h) => h.hostId === session?.hostId)?.hostId ?? online[0]?.hostId;
    if (!hostId) return c.json({ error: "no host online" }, 409);

    const body = c.req.raw.body;
    if (!body) return c.json({ error: "empty body" }, 400);

    try {
      const result = await relayUpload({
        hostId, threadId: id, fileName, declaredSize,
        body, sendRpc: sendHostRpc, chunkBytes: 2 * 1024 * 1024,
      });
      return c.json(result);
    } catch (err) {
      return c.json({ error: "upload failed", detail: String(err) }, 502);
    }
  });
```

> `deps.hosts.getOnlineHostsForUser` is the same method `ChatDomain` uses (chat.ts:96). Confirm `deps.hosts` is on `ServerDeps` (it is — `client.ts` already calls `deps.hosts.getHostForUser`).

- [ ] **Step 6: Build + commit**

```bash
pnpm build
git add packages/cloud/src/routes/upload.ts packages/cloud/src/routes/upload.test.ts packages/cloud/src/routes/client.ts
git commit -m "feat(cloud): streaming chat upload endpoint relaying to host"
```

---

## Task 7: Cloud — ChatDomain attachments (preamble + dispatch + broadcast)

**Files:**
- Modify: `packages/cloud/src/domains/chat.ts`
- Modify: `packages/cloud/src/routes/client.ts:255-262` (pass `msg.attachments`)
- Test: `packages/cloud/src/domains/chat.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/cloud/src/domains/chat.test.ts` (follow the file's existing harness for building a `ChatDomain` with a fake `HostRouter` that captures dispatch frames; grep the file for how it stubs `getHostByIdForUser(...).send`):

```ts
it("prepends an attachment preamble and forwards attachments on dispatch", async () => {
  // ... build domain with an online host whose conn.send pushes frames into `sent`
  await domain.handleClientSend({
    userId: "u1", threadId, content: "summarize this", sourceClientId: "c1",
    attachments: [{ name: "report.pdf", size: 100 }],
  });
  const dispatch = sent.find((f) => f.t === "dispatch");
  expect(dispatch.attachments).toEqual([{ name: "report.pdf", size: 100 }]);
  expect(dispatch.message).toContain(".cogni-uploads/report.pdf");
  expect(dispatch.message).toContain("summarize this");
});

it("persists attachments on the user message and broadcasts them", async () => {
  // ... same setup
  await domain.handleClientSend({
    userId: "u1", threadId, content: "see file", sourceClientId: "c1",
    attachments: [{ name: "a.png", size: 10 }],
  });
  const msgFrame = broadcasts.find((f) => f.t === "message" && f.role === "user");
  expect(msgFrame.attachments).toEqual([{ name: "a.png", size: 10 }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cloud/src/domains/chat.test.ts`
Expected: FAIL — `handleClientSend` rejects the extra `attachments` key / no preamble.

- [ ] **Step 3: Thread `attachments` through `chat.ts`**

Add a type alias near the top (after `PENDING_TTL_MS`):

```ts
type Attachment = { name: string; size: number };
```

Add `attachments` to `PendingFallback`:

```ts
interface PendingFallback {
  userId: string;
  threadId: string;
  content: string;
  attachments?: Attachment[];
  expiresAt: number;
}
```

Change `handleClientSend`'s signature + all `persistAndDispatch` calls inside it to carry attachments:

```ts
  async handleClientSend(input: {
    userId: string;
    threadId: string;
    content: string;
    sourceClientId: string;
    attachments?: Attachment[];
  }): Promise<void> {
    const { userId, threadId, content, sourceClientId, attachments } = input;
```

In the new-thread branch:

```ts
        await this.persistAndDispatch({ userId, threadId, content, attachments, hostId: chosen.hostId });
```

In the preferred-online branch:

```ts
      await this.persistAndDispatch({ userId, threadId, content, attachments, hostId: preferredOnline.hostId });
```

In the fallback branch, store attachments on the pending entry:

```ts
    this.pendingFallbacks.set(pendingMessageId, {
      userId, threadId, content, attachments, expiresAt: Date.now() + PENDING_TTL_MS,
    });
```

In `handleResolveFallback`, forward them:

```ts
    await this.persistAndDispatch({
      userId: input.userId, threadId: pending.threadId, content: pending.content,
      attachments: pending.attachments, hostId: input.targetHostId,
    });
```

Rewrite `persistAndDispatch` signature + body to persist, build the preamble, and dispatch:

```ts
  private async persistAndDispatch(p: {
    userId: string; threadId: string; content: string; hostId: string; attachments?: Attachment[];
  }): Promise<void> {
    const userMsg = await appendMessage(this.db, {
      threadId: p.threadId, role: "user", content: p.content, attachments: p.attachments,
    });
    await touchThread(this.db, p.threadId);
    this.clients.broadcast(p.threadId, {
      t: "message", threadId: p.threadId, messageId: userMsg.id, role: "user",
      content: userMsg.content, createdAt: userMsg.createdAt,
      ...(p.attachments && p.attachments.length > 0 ? { attachments: p.attachments } : {}),
    });

    // ... session selection unchanged (latest / reusable / openRunnerSession) ...

    try {
      conn.send({
        t: "dispatch",
        sessionId: session.id,
        threadId: p.threadId,
        adapter: ADAPTER,
        runnerSessionId: session.runnerSessionId,
        message: withAttachmentPreamble(p.content, p.attachments),
        ...(p.attachments && p.attachments.length > 0 ? { attachments: p.attachments } : {}),
      });
    } catch {
      // ... unchanged ...
    }
  }
```

Add the preamble helper at module scope (near `formatAskUserQuestion`):

```ts
/**
 * Prepend a short note pointing the agent at the files the user attached this
 * turn. They are materialized into the runner cwd under .cogni-uploads/ before
 * the turn runs, so a relative path is all the agent needs.
 */
function withAttachmentPreamble(content: string, attachments?: { name: string }[]): string {
  if (!attachments || attachments.length === 0) return content;
  const list = attachments.map((a) => `- ./.cogni-uploads/${a.name}`).join("\n");
  return `[用户上传了以下文件，位于当前工作目录的 ./.cogni-uploads/ 下：\n${list}]\n\n${content}`;
}
```

- [ ] **Step 4: Pass `msg.attachments` from the route**

In `client.ts`, the `msg.t === "send"` branch (lines 248-262) — add `attachments: msg.attachments` to BOTH the `workspaceChat.handleClientSend` and `deps.chat.handleClientSend` calls:

```ts
                  await deps.chat.handleClientSend({
                    userId: claims.userId,
                    threadId: msg.threadId,
                    content: msg.text,
                    sourceClientId: clientId,
                    attachments: msg.attachments,
                  });
```

> If `workspaceChat.handleClientSend` doesn't yet accept `attachments`, add the optional field to its signature too (same shape) and forward to its own dispatch — or pass through harmlessly if it ignores it. Keep the orchestrator path accepting-but-ignoring for now (orchestrator uploads are out of scope).

- [ ] **Step 5: Run test + build**

Run: `pnpm vitest run packages/cloud/src/domains/chat.test.ts`
Expected: PASS.
Run: `pnpm build && pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/cloud/src/domains/chat.ts packages/cloud/src/routes/client.ts packages/cloud/src/domains/chat.test.ts
git commit -m "feat(cloud): chat attachments preamble + dispatch + persistence"
```

---

## Task 8: UI — api.uploadFile + send carries attachments

**Files:**
- Modify: `packages/ui/src/transport/api.ts`
- Modify: `packages/ui/src/transport/ws-client.ts:118,382-384`
- Modify: `packages/ui/src/hooks/useThreadStream.ts:264`

- [ ] **Step 1: Add `uploadFile` to `ApiClient` (XHR for progress)**

In `api.ts`, add to the `ApiClient` class (near `fetchBlob`):

```ts
  /**
   * Upload one file as agent context for a thread. Uses XHR (not fetch) so we
   * get `upload.onprogress` for the composer's per-file progress bar. Resolves
   * with the host's final (de-duped) name + size; rejects with ApiError on
   * non-2xx (e.g. 409 host offline, 502 host write failed).
   */
  uploadFile(
    threadId: string,
    file: File,
    onProgress?: (fraction: number) => void,
  ): Promise<{ name: string; size: number }> {
    const url = `${this.cloudUrl}/api/threads/${threadId}/uploads`;
    const token = this.cfg.getToken();
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText) as { name: string; size: number }); }
          catch { reject(new ApiError(xhr.status, "bad upload response")); }
        } else {
          reject(new ApiError(xhr.status, `POST ${url} → ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(new ApiError(0, `POST ${url} → network error`));
      xhr.send(file);
    });
  }
```

- [ ] **Step 2: Carry attachments on the `send` frame**

In `ws-client.ts`, change the `WsClient` interface `send` (line 118):

```ts
  send(threadId: string, text: string, attachments?: { name: string; size: number }[]): boolean;
```

And the implementation (lines 382-384):

```ts
    send(threadId, text, attachments) {
      return sendFrame(attachments && attachments.length > 0
        ? { t: "send", threadId, text, attachments }
        : { t: "send", threadId, text });
    },
```

- [ ] **Step 3: Widen `useThreadStream.send`**

In `useThreadStream.ts` (line 264):

```ts
  const send = (text: string, attachments?: { name: string; size: number }[]) =>
    api.wsClient.send(threadId, text, attachments);
```

- [ ] **Step 4: Build + typecheck + commit**

Run: `pnpm build && pnpm typecheck`
Expected: clean (UI is source-only; `tsc --noEmit` covers it).

```bash
git add packages/ui/src/transport/api.ts packages/ui/src/transport/ws-client.ts packages/ui/src/hooks/useThreadStream.ts
git commit -m "feat(ui): uploadFile transport + send carries attachments"
```

---

## Task 9: UI — Composer attach UI + useUploads hook

**Files:**
- Create: `packages/ui/src/hooks/useUploads.ts`
- Modify: `packages/ui/src/components/Composer.tsx`
- Modify: `packages/ui/src/components/composer.css`
- Modify: `packages/ui/src/components/Conversation.tsx:172`
- Modify: `packages/ui/src/components/Welcome.tsx:65`
- Modify: `packages/ui/src/index.ts` (export `useUploads` if other apps need it; optional)

- [ ] **Step 1: Implement `useUploads`**

Create `packages/ui/src/hooks/useUploads.ts`:

```ts
import { useCallback, useState } from "react";

export interface UploadItem {
  /** Stable client id for list keys. */
  localId: string;
  file: File;
  status: "uploading" | "done" | "error";
  progress: number; // 0..1
  /** Host's final name once committed (may differ from file.name after de-dupe). */
  name?: string;
  size?: number;
  error?: string;
}

export interface UseUploads {
  items: UploadItem[];
  /** True while any item is still uploading — composer disables send. */
  busy: boolean;
  add: (files: FileList | File[]) => void;
  remove: (localId: string) => void;
  retry: (localId: string) => void;
  /** Committed attachments for the `send` frame, then clears the tray. */
  takeAttachments: () => { name: string; size: number }[];
  reset: () => void;
}

/**
 * Composer upload tray. `uploadFn` is `api.uploadFile` bound to the active
 * threadId by the caller (chat: the open thread; task reply: executionThreadId).
 */
export function useUploads(
  uploadFn: (file: File, onProgress: (f: number) => void) => Promise<{ name: string; size: number }>,
): UseUploads {
  const [items, setItems] = useState<UploadItem[]>([]);

  const patch = useCallback((localId: string, p: Partial<UploadItem>) => {
    setItems((prev) => prev.map((it) => (it.localId === localId ? { ...it, ...p } : it)));
  }, []);

  const run = useCallback((localId: string, file: File) => {
    uploadFn(file, (f) => patch(localId, { progress: f }))
      .then((res) => patch(localId, { status: "done", progress: 1, name: res.name, size: res.size }))
      .catch((err) => patch(localId, { status: "error", error: String(err) }));
  }, [uploadFn, patch]);

  const add = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files);
    const next: UploadItem[] = arr.map((file) => ({
      localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file, status: "uploading", progress: 0,
    }));
    setItems((prev) => [...prev, ...next]);
    for (const it of next) run(it.localId, it.file);
  }, [run]);

  const remove = useCallback((localId: string) => {
    setItems((prev) => prev.filter((it) => it.localId !== localId));
  }, []);

  const retry = useCallback((localId: string) => {
    setItems((prev) => {
      const it = prev.find((x) => x.localId === localId);
      if (it) run(localId, it.file);
      return prev.map((x) => (x.localId === localId ? { ...x, status: "uploading", progress: 0, error: undefined } : x));
    });
  }, [run]);

  const takeAttachments = useCallback(() => {
    const done = items.filter((it) => it.status === "done" && it.name && it.size != null);
    setItems([]);
    return done.map((it) => ({ name: it.name!, size: it.size! }));
  }, [items]);

  const reset = useCallback(() => setItems([]), []);

  const busy = items.some((it) => it.status === "uploading");
  return { items, busy, add, remove, retry, takeAttachments, reset };
}
```

- [ ] **Step 2: Extend `Composer` props + render the tray, enable attach, drag-drop, gate send**

In `Composer.tsx`, extend the prop type:

```ts
import type { UploadItem } from "../hooks/useUploads.js";
```

Add to the destructured props and type:

```ts
  uploads,
```
```ts
  /** Optional upload tray. When present, the attach button + drag-drop activate. */
  uploads?: {
    items: UploadItem[];
    busy: boolean;
    add: (files: FileList | File[]) => void;
    remove: (localId: string) => void;
    retry: (localId: string) => void;
  };
```

Add a hidden file input ref near `textareaRef`:

```ts
  const fileInputRef = useRef<HTMLInputElement | null>(null);
```

Gate submit on upload state — change `canSubmit`:

```ts
  const canSubmit = hasText && !disabled && !(uploads?.busy ?? false);
```

Render the chip tray just inside the form, above the textarea (after `{status && <StatusPill .../>}` is fine; place chips right above `<textarea>`):

```tsx
        {uploads && uploads.items.length > 0 && (
          <div className="composer__attachments">
            {uploads.items.map((it) => (
              <div
                key={it.localId}
                className={"attach-chip" + (it.status === "error" ? " attach-chip--error" : "")}
                title={it.error ?? it.file.name}
              >
                <span className="attach-chip__icon" aria-hidden="true">{Icon.attach}</span>
                <span className="attach-chip__name">{it.name ?? it.file.name}</span>
                <span className="attach-chip__size">{formatBytes(it.size ?? it.file.size)}</span>
                {it.status === "uploading" && (
                  <span className="attach-chip__bar"><span style={{ width: `${Math.round(it.progress * 100)}%` }} /></span>
                )}
                {it.status === "error" && (
                  <button type="button" className="attach-chip__retry" onClick={() => uploads.retry(it.localId)} title="重试">↻</button>
                )}
                <button type="button" className="attach-chip__x" onClick={() => uploads.remove(it.localId)} aria-label="移除附件">✕</button>
              </div>
            ))}
          </div>
        )}
```

Wire drag-drop on the `<form>` (add handlers to the existing `<form>` element):

```tsx
        onDragOver={uploads ? (e) => { e.preventDefault(); } : undefined}
        onDrop={uploads ? (e) => { e.preventDefault(); if (e.dataTransfer.files.length) uploads.add(e.dataTransfer.files); } : undefined}
```

Replace the disabled attach button (lines 88-96) with an active one + hidden input:

```tsx
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              if (uploads && e.target.files && e.target.files.length) uploads.add(e.target.files);
              e.target.value = ""; // allow re-selecting the same file
            }}
          />
          <button
            type="button"
            className="composer__icon-btn"
            disabled={disabled || !uploads}
            title={uploads ? "添加附件" : "附件功能不可用"}
            aria-label="Attach file"
            onClick={() => fileInputRef.current?.click()}
          >
            {Icon.attach}
          </button>
```

Add the `formatBytes` helper at the bottom of the file:

```ts
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
```

- [ ] **Step 3: Add CSS for the tray**

Append to `packages/ui/src/components/composer.css`:

```css
.composer__attachments { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 8px 0; }
.attach-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 8px;
  background: rgba(127,127,127,0.12); font-size: 12px; max-width: 240px; }
.attach-chip--error { background: rgba(220,60,60,0.16); color: #c0392b; }
.attach-chip__icon { display: inline-flex; opacity: 0.7; }
.attach-chip__name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 130px; }
.attach-chip__size { opacity: 0.6; }
.attach-chip__bar { position: relative; width: 40px; height: 3px; background: rgba(127,127,127,0.3); border-radius: 2px; overflow: hidden; }
.attach-chip__bar > span { position: absolute; left: 0; top: 0; bottom: 0; background: currentColor; transition: width .15s; }
.attach-chip__x, .attach-chip__retry { border: none; background: none; cursor: pointer; font-size: 12px; padding: 0 2px; color: inherit; opacity: 0.7; }
.attach-chip__x:hover, .attach-chip__retry:hover { opacity: 1; }
```

- [ ] **Step 4: Wire `useUploads` in `Conversation.tsx` and `Welcome.tsx`**

In `Conversation.tsx`, near the existing stream hook usage, construct the tray and pass it + use its attachments on submit. The component already has `api` (the `ApiClient`) and the open `threadId` in scope (it renders a specific thread). Example shape:

```tsx
import { useUploads } from "../hooks/useUploads.js";
// ...
const uploads = useUploads((file, onProgress) => api.uploadFile(threadId, file, onProgress));
const submit = () => {
  const attachments = uploads.takeAttachments();
  send(draft, attachments);   // send is from useThreadStream (Task 8)
  setDraft("");
};
// ...
<Composer draft={draft} setDraft={setDraft} onSubmit={submit} status={status} uploads={uploads} />
```

> Read `Conversation.tsx` first to match its real prop names (`api`, `threadId`, `send`, `draft`/`setDraft`). Keep the existing submit side-effects (clearing draft, etc.); only add `takeAttachments()` + pass `attachments` into `send`.

In `Welcome.tsx` (the new-thread first message at line 65): Welcome creates a thread, then sends the first message. Uploads need a threadId, which Welcome may not have until the thread is created. Wire it so the file picker is enabled only after the thread exists, OR create the thread on first attach. Simplest: enable uploads once Welcome has obtained a `threadId` (it already creates one to send the first message). If Welcome defers thread creation to submit-time, gate the attach button by passing `uploads` only when a threadId exists; otherwise omit `uploads` (attach stays disabled). Match the file's actual flow when implementing.

- [ ] **Step 5: Manual smoke (deferred to Task 12 full verification)**

Run: `pnpm build && pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/hooks/useUploads.ts packages/ui/src/components/Composer.tsx packages/ui/src/components/composer.css packages/ui/src/components/Conversation.tsx packages/ui/src/components/Welcome.tsx packages/ui/src/index.ts
git commit -m "feat(ui): composer attach button, drag-drop, upload chips + progress"
```

---

## Task 10: UI — render attachment chips on user message bubbles

**Files:**
- Modify: `packages/ui/src/components/ChatBlocks.tsx` (`UserMessage`)
- Verify: `packages/ui/src/hooks/useThreadStream.ts` carries `attachments` on message state (it stores `MessageView`s from `getThread` + `message` frames; both now include `attachments`).

- [ ] **Step 1: Read `ChatBlocks.tsx` `UserMessage`**

Run: `grep -n "UserMessage" packages/ui/src/components/ChatBlocks.tsx`
Read the component to find its props (it currently takes the message text/content).

- [ ] **Step 2: Pass + render attachments on the user bubble**

Extend `UserMessage`'s props to accept `attachments?: { name: string; size: number }[]` and render chips under the text:

```tsx
{attachments && attachments.length > 0 && (
  <div className="composer__attachments" style={{ padding: "6px 0 0" }}>
    {attachments.map((a) => (
      <span className="attach-chip" key={a.name}>
        <span className="attach-chip__icon" aria-hidden="true">{Icon.attach}</span>
        <span className="attach-chip__name">{a.name}</span>
      </span>
    ))}
  </div>
)}
```

> Reuse the `.attach-chip` styles from `composer.css` (already global to `@cogni/ui`). Import `Icon` if not already imported in `ChatBlocks.tsx`.

- [ ] **Step 3: Pass attachments where `UserMessage` is rendered**

Find where the timeline maps messages to `<UserMessage>` (grep `UserMessage` usage in `Conversation.tsx` / the timeline builder) and forward `m.attachments`.

- [ ] **Step 4: Build + commit**

Run: `pnpm build && pnpm typecheck`
Expected: clean.

```bash
git add packages/ui/src/components/ChatBlocks.tsx packages/ui/src/components/Conversation.tsx
git commit -m "feat(ui): show attachment chips on user message bubbles"
```

---

## Task 11: Project-task reply uploads

**Goal:** Reuse the same mechanism in the task drawer's reply input so attaching a file to a `needs-input` task reply lands it in the task's worktree.

**Files:**
- Modify: `packages/cloud/src/routes/*` (add `POST /api/tasks/:taskId/uploads`)
- Modify: the task-reply composer component in `packages/ui` (locate first)
- Modify: `packages/ui/src/transport/api.ts` (`uploadTaskFile`)

- [ ] **Step 1: Locate the task reply composer + task reply route**

Run:
```bash
grep -rn "replyToTask\|/reply\|executionThreadId" packages/ui/src packages/cloud/src/routes | head -30
```
Identify (a) which component renders the reply input in the task drawer, and (b) the cloud route handling `POST /api/tasks/:taskId/reply` and how it resolves the task's `executionThreadId`.

- [ ] **Step 2: Add the cloud task-upload route**

In the task routes file, mirror the thread upload route but resolve the host + threadId from the task:

```ts
app.post("/api/tasks/:taskId/uploads", async (c) => {
  const { userId } = c.get("claims");
  const taskId = c.req.param("taskId");
  const task = await getTask(deps.db, taskId);
  if (!task) return c.json({ error: "not found" }, 404);
  const project = await getProject(deps.db, task.projectId);
  if (!project || project.userId !== userId) return c.json({ error: "not found" }, 404);
  if (!task.executionThreadId) return c.json({ error: "task not started" }, 409);

  const fileName = decodeURIComponent(c.req.header("X-Filename") ?? "").trim() || "upload";
  const declaredSize = Number(c.req.header("Content-Length") ?? 0) || 0;
  const hostId = task.hostId ?? project.defaultHostId;
  const online = deps.hosts.getOnlineHostsForUser(userId);
  if (!online.some((h) => h.hostId === hostId)) return c.json({ error: "no host online" }, 409);

  const body = c.req.raw.body;
  if (!body) return c.json({ error: "empty body" }, 400);
  try {
    const result = await relayUpload({
      hostId, threadId: task.executionThreadId, fileName, declaredSize,
      body, sendRpc: sendHostRpc, chunkBytes: 2 * 1024 * 1024,
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: "upload failed", detail: String(err) }, 502);
  }
});
```

> Confirm the real field names on the task row (`executionThreadId`, `hostId`, `projectId`) by reading `getTask`'s return type / `projectTasks` schema. Adjust if they differ. Confirm how project-task dispatch (in `domains/project/`) builds its `dispatch` frame and ADD `attachments` there the same way `chat.ts` does — read the reply→dispatch path and prepend the preamble + forward `attachments` (the task's next turn carries them). The host materializes by `threadId === executionThreadId`, so worktree placement is automatic.

- [ ] **Step 3: Add `uploadTaskFile` to `ApiClient`**

```ts
uploadTaskFile(taskId: string, file: File, onProgress?: (f: number) => void) {
  // identical to uploadFile but POSTs to /api/tasks/${taskId}/uploads
}
```
Factor the shared XHR body into a private `uploadTo(url, file, onProgress)` and have both `uploadFile` and `uploadTaskFile` call it.

- [ ] **Step 4: Wire `useUploads` into the task reply composer**

Construct `const uploads = useUploads((file, onProgress) => api.uploadTaskFile(taskId, file, onProgress));` in the reply component, pass to its Composer (or reply input), and append `takeAttachments()` to the `replyToTask` call. The reply route's dispatch must forward attachments (Step 2 note).

> If the task reply input is NOT the shared `Composer` component, add the same attach button + tray markup inline, or refactor it to use `Composer` with `uploads`. Prefer reuse.

- [ ] **Step 5: Build + typecheck + commit**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: clean.

```bash
git add packages/cloud/src packages/ui/src
git commit -m "feat: project-task reply file uploads"
```

---

## Task 12: Full verification (per MEMORY.md stale-process checklist)

**Files:** none (verification only)

- [ ] **Step 1: Full CI-equivalent check**

Run: `pnpm ci`
Expected: build + typecheck + vitest all green.

- [ ] **Step 2: Kill stale processes before manual test**

Run:
```bash
ps -ef | grep -iE "tauri|cargo|vite|Cogni\.app" | grep -v grep
ps -ef | grep -E "target/(debug|release)/(desktop|cogni)" | grep -v grep
```
Kill stale instances and PPID=1 orphans. Rebuild `packages/*` (`pnpm build`) so the runner-host sidecar (`node dist/main.js`) runs the new code.

- [ ] **Step 3: Manual end-to-end (web client is fastest)**

Start cloud (`pnpm --filter @cogni/cloud dev`), the runner-host, and `pnpm --filter web dev`. Then:
1. Open a chat thread, click the attach button, pick a PDF + a PNG → chips appear with progress, then settle to "done".
2. Drag-drop a third file onto the composer → chip appears.
3. Remove one chip; confirm send is disabled while an upload is mid-flight, enabled once all settle.
4. Type a message + send → user bubble shows file chips; the agent's reply references the file contents (confirm it read `.cogni-uploads/<name>`).
5. On the host, confirm files exist at `~/.cogni/uploads/<threadId>/` and were copied to `~/.cogni/threads/<threadId>/.cogni-uploads/`.
6. Reload (Cmd+R in the Tauri webview / browser refresh) → the user bubble still shows the chips (metadata persisted).
7. Try a >50MB file → chip shows the size error; retry a deliberately-failed upload (e.g. host offline) → 409 path shows error + retry works once host returns.

- [ ] **Step 4: Write the changelog (per user's global git rule)**

Create `changelog/<YYYYMMDD_HHMMSS>.md` summarizing the feature + grouped changes. Ensure `changelog/` is gitignored-checked per the user's convention.

- [ ] **Step 5: Final commit**

```bash
git add changelog/
git commit -m "docs(changelog): file upload feature"
```

---

## Self-Review Notes (for the executor)

- **Scope = threadId everywhere.** Host staging dir, dispatch materialization, and both cloud upload routes key on the same id (chat thread, or task `executionThreadId`). Don't introduce a separate task-scoped key.
- **The cloud never stores bytes.** `relayUpload` streams; `messages.attachmentsJson` holds only `{name,size}`.
- **Names can change.** The host de-dupes, so the client must use the *returned* `name` (in `takeAttachments`), not `file.name`, for the `send` frame.
- **50MB cap is enforced host-side** (begin fast-reject + cumulative). The UI doesn't need to block large files but should surface the host's `upload-too-large` error on the chip.
- **`verbatimModuleSyntax`:** every type-only import must use `import type`. **`noUncheckedIndexedAccess`:** array lookups (e.g. `online[0]`) are `T | undefined` — guard them (the route uses `?.hostId ?? ...`).
