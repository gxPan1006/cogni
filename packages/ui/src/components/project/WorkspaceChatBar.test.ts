/**
 * @vitest-environment node
 *
 * The repo's vitest harness is `environment: "node"` with no jsdom / no
 * @testing-library/react (forbidden to introduce here). So we can't render
 * <WorkspaceChatBar> in a test. Per the plan's documented downgrade path we
 * lock the one piece of pure logic the component exposes: the scope → idle
 * placeholder text mapping. Rendering / focus-to-expand behaviour is verified
 * by exercising the desktop / web shells in dev (see the acceptance checklist).
 *
 * Importing from the .ts entry below pulls in React + the .css import, which
 * vitest's transform tolerates (the css resolves to an empty module under
 * node), but to keep this test free of any DOM dependency we import only the
 * pure function.
 */
import { describe, expect, it } from "vitest";
import { scopePlaceholder } from "./WorkspaceChatBar.js";

describe("scopePlaceholder", () => {
  it("uses a workspace-wide hint for the workspace scope", () => {
    expect(scopePlaceholder({ kind: "workspace" })).toBe(
      "让 Cogni 帮你建任务、关任务、整理项目…",
    );
  });

  it("embeds the project name for the project scope", () => {
    expect(
      scopePlaceholder({ kind: "project", projectId: "p1", projectName: "贪吃蛇" }),
    ).toBe("在「贪吃蛇」里帮你建任务、改任务…");
  });

  it("never renders literal 'undefined' when the project name is missing/blank", () => {
    // The bug class behind the「undefined」placeholder: a half-loaded or
    // nameless project. Degrade to a neutral label instead of interpolating.
    for (const bad of [undefined, "", "   "]) {
      const out = scopePlaceholder({
        kind: "project",
        projectId: "p1",
        projectName: bad as unknown as string,
      });
      expect(out).not.toContain("undefined");
      expect(out).toBe("在「这个项目」里帮你建任务、改任务…");
    }
  });
});
