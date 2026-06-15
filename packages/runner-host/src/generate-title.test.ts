import { describe, it, expect } from "vitest";
import { generateThreadTitle, GenerateTitleError } from "./generate-title.js";

describe("generateThreadTitle", () => {
  it("returns sanitized title from a clean response", async () => {
    const runner = async () => "贪吃蛇小游戏";
    const out = await generateThreadTitle(
      { adapter: "claude-code", userMessage: "我想做一个贪吃蛇", assistantReply: "好的" },
      runner,
    );
    expect(out.title).toBe("贪吃蛇小游戏");
  });

  it("strips Title:/标题：prefixes", async () => {
    const runner = async () => "标题：会话起名实现";
    const out = await generateThreadTitle(
      { adapter: "claude-code", userMessage: "我要做这个功能", assistantReply: "" },
      runner,
    );
    expect(out.title).toBe("会话起名实现");
  });

  it("accepts the Claude Code snapshot adapter", async () => {
    const out = await generateThreadTitle(
      { adapter: "claude-code-snapshot", userMessage: "我要跑自己的 snapshot", assistantReply: "" },
      async () => "Snapshot 调试",
    );
    expect(out.title).toBe("Snapshot 调试");
  });

  it("strips surrounding quotes and code fences", async () => {
    const runner = async () => '```\n"如何调试 SSH 隧道"\n```';
    const out = await generateThreadTitle(
      { adapter: "claude-code", userMessage: "ssh -L 不通", assistantReply: "" },
      runner,
    );
    expect(out.title).toBe("如何调试 SSH 隧道");
  });

  it("keeps first non-empty line when CLI emits multi-line", async () => {
    const runner = async () => "\n\n讨论 Tauri 升级方案\n\n(其他闲聊内容)\n";
    const out = await generateThreadTitle(
      { adapter: "claude-code", userMessage: "tauri 2.0 升级", assistantReply: "" },
      runner,
    );
    expect(out.title).toBe("讨论 Tauri 升级方案");
  });

  it("rejects unsupported adapters loudly", async () => {
    await expect(
      generateThreadTitle(
        { adapter: "codex", userMessage: "hi", assistantReply: "" },
        async () => "x",
      ),
    ).rejects.toBeInstanceOf(GenerateTitleError);
  });

  it("rejects empty user message", async () => {
    await expect(
      generateThreadTitle(
        { adapter: "claude-code", userMessage: "   ", assistantReply: "" },
        async () => "x",
      ),
    ).rejects.toBeInstanceOf(GenerateTitleError);
  });

  it("rejects empty CLI output", async () => {
    await expect(
      generateThreadTitle(
        { adapter: "claude-code", userMessage: "hi", assistantReply: "" },
        async () => "   \n\n   ",
      ),
    ).rejects.toBeInstanceOf(GenerateTitleError);
  });
});
