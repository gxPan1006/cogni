import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandTilde, resolveUserPath } from "./paths.js";

describe("expandTilde", () => {
  it("expands a bare ~ to the home dir", () => {
    expect(expandTilde("~")).toBe(homedir());
  });

  it("expands a leading ~/ to a path under the home dir", () => {
    expect(expandTilde("~/code/cc-view")).toBe(join(homedir(), "code/cc-view"));
  });

  it("leaves absolute paths untouched", () => {
    expect(expandTilde("/Users/x/code")).toBe("/Users/x/code");
  });

  it("leaves ~otheruser and embedded ~ untouched", () => {
    expect(expandTilde("~bob/code")).toBe("~bob/code");
    expect(expandTilde("/tmp/a~b")).toBe("/tmp/a~b");
  });
});

describe("resolveUserPath", () => {
  it("turns a ~ path into an absolute path under home (the dispatch bug)", () => {
    // Regression: resolve("~/code/cc-view") with cwd=/ yields "/~/code/cc-view",
    // which breaks `git init`. resolveUserPath must expand first.
    const out = resolveUserPath("~/code/cc-view");
    expect(out).toBe(join(homedir(), "code/cc-view"));
    expect(out.startsWith("/~")).toBe(false);
  });

  it("is idempotent on already-absolute paths", () => {
    expect(resolveUserPath("/Users/x/code/cc-view")).toBe("/Users/x/code/cc-view");
  });
});
