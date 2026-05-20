import { describe, it, expect } from "vitest";
import { sanitizeFolderName, suggestRepoPath } from "./new-project-path.js";

describe("sanitizeFolderName", () => {
  it("keeps unicode, trims, collapses spaces", () => {
    expect(sanitizeFolderName("  本地工具显示器  ")).toBe("本地工具显示器");
    expect(sanitizeFolderName("My App")).toBe("My-App");
  });
  it("drops slashes/control chars, keeps space→dash for the rest", () => {
    expect(sanitizeFolderName("a/b c")).toBe("ab-c");
  });
  it("empty when blank", () => {
    expect(sanitizeFolderName("   ")).toBe("");
  });
});

describe("suggestRepoPath", () => {
  it("joins root + slug", () => {
    expect(suggestRepoPath("/Users/x/cogni", "本地工具显示器")).toBe("/Users/x/cogni/本地工具显示器");
  });
  it("trims a trailing slash on root", () => {
    expect(suggestRepoPath("/Users/x/cogni/", "App")).toBe("/Users/x/cogni/App");
  });
  it("empty when no root or no name", () => {
    expect(suggestRepoPath(null, "App")).toBe("");
    expect(suggestRepoPath("/Users/x/cogni", "")).toBe("");
  });
});
