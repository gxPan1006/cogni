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
