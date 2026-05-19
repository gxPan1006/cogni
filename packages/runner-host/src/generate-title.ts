/**
 * Spawn `claude --print --model claude-haiku-4-5` to summarise the first
 * turn of a chat into a short title. Used by the `generate-thread-title`
 * host RPC; cloud calls this immediately after the first assistant reply
 * lands so the sidebar can replace "New chat" with something readable.
 *
 * Why claude-haiku-4-5: it's the smallest / fastest Claude model bundled with
 * the same `claude` CLI the chat runner already depends on — no extra API
 * key, no new SDK dependency. Cold-start is sub-second on the user's box.
 *
 * Why a separate `--print` invocation (not a runner session): titling has
 * to be one-shot and non-streaming, must NOT pollute the chat thread's
 * conversation history, and uses a different model than the main turn. A
 * fresh `claude --print` invocation gives us all three for free.
 *
 * Failure mode: if the CLI errors or returns garbage, we throw a
 * `GenerateTitleError` with a `code` the dispatcher maps to `ok:false`.
 * The cloud then leaves the thread title as "New chat" — non-fatal.
 */

import { execa } from "execa";
import type { GenerateThreadTitleRequest, GenerateThreadTitleResponse } from "@cogni/contract";

/** Hard cap on inputs we hand to the model — Haiku context is huge but we
 *  only need a topic gist, and the user's first turn could be many KB of
 *  pasted text. 2 KB per field keeps the spawn cheap. */
const INPUT_CHAR_CAP = 2000;

/** Hard cap on the output we accept as a title. The Haiku prompt asks for
 *  ≤ 60 chars; we accept up to 120 to allow CJK width slack but truncate
 *  any longer string to stay within the contract schema (max 120). */
const TITLE_MAX_CHARS = 80;

/** Prompt text — sent on stdin to `claude --print`. Bilingual hint because
 *  the user's first message might be Chinese or English; we tell the model
 *  to mirror the dominant language. */
const TITLE_PROMPT_HEAD = [
  "你的任务：为下面这段对话生成一个简短的会话标题，让用户在侧边栏一眼看出聊的是什么。",
  "",
  "要求：",
  "- 4-12 个字（中文）/ 4-8 个英文单词",
  "- 不要标点、不要引号、不要前缀（如 '标题：'）",
  "- 与对话主语言保持一致（用户用中文你就回中文，用英文就回英文）",
  "- 只输出标题这一行，不要任何解释或多余文字",
  "",
].join("\n");

export class GenerateTitleError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "GenerateTitleError";
  }
}

/** Injectable runner so the unit test can stub the CLI. */
export type TitleRunner = (params: { prompt: string }) => Promise<string>;

/** Default runner: `claude --print --model claude-haiku-4-5`, prompt on stdin,
 *  stdout collected as the title. We deliberately do NOT use stream-json
 *  here — for a non-streaming, no-tool one-shot, plain text output is the
 *  simplest contract. */
export const defaultTitleRunner: TitleRunner = async ({ prompt }) => {
  const proc = await execa("claude", ["--print", "--model", "claude-haiku-4-5"], {
    input: prompt,
    reject: false,
    timeout: 30_000,
  });
  if (proc.exitCode !== 0) {
    throw new GenerateTitleError(
      "claude-cli-failed",
      `claude --print exited ${proc.exitCode}: ${(proc.stderr || "").slice(0, 200)}`,
    );
  }
  return proc.stdout ?? "";
};

export async function generateThreadTitle(
  req: GenerateThreadTitleRequest,
  runner: TitleRunner = defaultTitleRunner,
): Promise<GenerateThreadTitleResponse> {
  if (req.adapter !== "claude-code") {
    // Cloud currently only dispatches the chat domain through claude-code;
    // if a future adapter triggers this RPC, fail loud rather than silently
    // mis-using the claude CLI for a non-claude conversation.
    throw new GenerateTitleError(
      "unsupported-adapter",
      `generate-thread-title only supports adapter=claude-code (got ${req.adapter})`,
    );
  }

  const user = req.userMessage.slice(0, INPUT_CHAR_CAP).trim();
  const assistant = req.assistantReply.slice(0, INPUT_CHAR_CAP).trim();
  if (!user) {
    throw new GenerateTitleError("empty-input", "userMessage is empty");
  }

  const prompt =
    TITLE_PROMPT_HEAD +
    `用户：${user}\n` +
    (assistant ? `助手：${assistant}\n` : "") +
    "\n标题：";

  const raw = await runner({ prompt });
  const title = sanitizeTitle(raw);
  if (!title) {
    throw new GenerateTitleError("empty-title", `claude returned no usable title (raw: ${raw.slice(0, 200)})`);
  }
  return { title };
}

/** Strip whitespace, drop common prefix labels ("Title:" / "标题：" / quotes),
 *  collapse to a single line, hard-truncate to TITLE_MAX_CHARS. */
function sanitizeTitle(raw: string): string {
  let s = raw.trim();
  if (!s) return "";
  // claude-code occasionally wraps a single-line answer in a code-fence or
  // adds a "Title:" prefix despite the prompt. Strip both.
  s = s.replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/i, "");
  s = s.replace(/^(标题|title)\s*[:：]\s*/i, "");
  // Some replies use "## Title" style headings.
  s = s.replace(/^#+\s*/, "");
  // Quote-stripping for "..." or 「...」.
  s = s.replace(/^["'「『](.*)["'」』]$/s, "$1");
  // Multi-line outputs: keep first non-empty line.
  const firstLine = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  s = firstLine;
  // Trailing punctuation cleanup (a Haiku-ish prompt rarely needs it).
  s = s.replace(/[。.!！?？\s]+$/g, "").trim();
  if (s.length > TITLE_MAX_CHARS) s = s.slice(0, TITLE_MAX_CHARS).trim();
  return s;
}
