import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsBrowse, FsBrowseError } from "./fs-browse.js";

let tmp = "";
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "cogni-fsbrowse-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("fsBrowse", () => {
  it("lists files and dirs with file sizes", async () => {
    await mkdir(join(tmp, "src"));
    await mkdir(join(tmp, "docs"));
    await writeFile(join(tmp, "README.md"), "hello\n", "utf8"); // 6 bytes
    const res = await fsBrowse({ path: tmp });
    expect(res.cwd).toBe(tmp);
    const names = res.entries.map((e) => e.name);
    expect(names).toContain("src");
    expect(names).toContain("docs");
    expect(names).toContain("README.md");
    const readme = res.entries.find((e) => e.name === "README.md")!;
    expect(readme.type).toBe("file");
    expect(readme.size).toBe(6);
    const src = res.entries.find((e) => e.name === "src")!;
    expect(src.type).toBe("dir");
    // No `size` for directories — sentinel against accidentally leaking
    // the directory inode size as if it were a file body length.
    expect(src.size).toBeUndefined();
  });

  it("filters hidden entries by default", async () => {
    await mkdir(join(tmp, "visible"));
    await mkdir(join(tmp, ".hidden-dir"));
    await writeFile(join(tmp, ".bashrc"), "x\n");
    const res = await fsBrowse({ path: tmp });
    const names = res.entries.map((e) => e.name);
    expect(names).toContain("visible");
    expect(names).not.toContain(".hidden-dir");
    expect(names).not.toContain(".bashrc");
  });

  it("includes hidden entries when the requested path is itself hidden", async () => {
    const hidden = join(tmp, ".config");
    await mkdir(hidden);
    await writeFile(join(hidden, ".secret-file"), "ok\n");
    await writeFile(join(hidden, "regular.txt"), "ok\n");
    const res = await fsBrowse({ path: hidden });
    const names = res.entries.map((e) => e.name);
    expect(names).toContain(".secret-file");
    expect(names).toContain("regular.txt");
  });

  it("sorts dirs first, then files, alphabetical inside each group", async () => {
    await mkdir(join(tmp, "zzz-dir"));
    await mkdir(join(tmp, "aaa-dir"));
    await writeFile(join(tmp, "aaa-file.txt"), "");
    await writeFile(join(tmp, "zzz-file.txt"), "");
    const res = await fsBrowse({ path: tmp });
    expect(res.entries.map((e) => e.name)).toEqual([
      "aaa-dir",
      "zzz-dir",
      "aaa-file.txt",
      "zzz-file.txt",
    ]);
  });

  it("rejects relative paths", async () => {
    await expect(fsBrowse({ path: "relative/path" })).rejects.toMatchObject({
      code: "path-must-be-absolute",
    });
  });

  it("returns path-not-found for a non-existent path", async () => {
    await expect(fsBrowse({ path: join(tmp, "ghost") })).rejects.toMatchObject({
      code: "path-not-found",
    });
  });

  it("returns not-a-directory when the path is a regular file", async () => {
    const file = join(tmp, "note.txt");
    await writeFile(file, "hello\n");
    await expect(fsBrowse({ path: file })).rejects.toMatchObject({
      code: "not-a-directory",
    });
  });

  it("never includes file body bytes in entries — type+name+size only", async () => {
    // SECURITY REGRESSION TEST. fs-browse must never leak file contents;
    // even an accidental field rename to `body` / `content` would fail this.
    await writeFile(join(tmp, "secret.txt"), "super-secret-token-99999", "utf8");
    const res = await fsBrowse({ path: tmp });
    const entry = res.entries.find((e) => e.name === "secret.txt")!;
    // Each entry has only the documented shape; assert no stray keys.
    const keys = Object.keys(entry).sort();
    expect(keys).toEqual(["name", "size", "type"]);
    // And the serialized JSON does NOT contain the file body anywhere.
    expect(JSON.stringify(res)).not.toContain("super-secret-token");
  });

  it("skips symlinks (not in the file|dir enum)", async () => {
    await writeFile(join(tmp, "target.txt"), "x\n");
    try {
      await symlink(join(tmp, "target.txt"), join(tmp, "link.txt"));
    } catch {
      // Some sandboxed filesystems disallow symlinks; the symlink branch
      // is best-effort coverage, so we just skip the assertion.
      return;
    }
    const res = await fsBrowse({ path: tmp });
    const names = res.entries.map((e) => e.name);
    expect(names).toContain("target.txt");
    expect(names).not.toContain("link.txt");
  });

  it("throws FsBrowseError (not raw Error) for known failures", async () => {
    await expect(fsBrowse({ path: join(tmp, "ghost") })).rejects.toBeInstanceOf(FsBrowseError);
  });
});
