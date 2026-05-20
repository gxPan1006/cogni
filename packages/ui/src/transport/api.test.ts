/**
 * @vitest-environment node
 *
 * Transport client tests. Focused on the response-envelope contracts that have
 * bitten us: `GET /api/projects/:id` returns `{ project, taskCount }`, so the
 * client must unwrap it to a bare `Project` (otherwise `board.project.name` is
 * undefined → the breadcrumb reads "项目未找到").
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiClient } from "./api.js";

function client(): ApiClient {
  return new ApiClient({ cloudUrl: "http://test.local", getToken: () => "tok" });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("ApiClient.getProject", () => {
  afterEach(() => vi.restoreAllMocks());

  it("unwraps the { project, taskCount } envelope to the bare Project", async () => {
    const project = { id: "p1", name: "贪吃蛇游戏" };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ project, taskCount: 3 })));

    const got = await client().getProject("p1");

    expect(got).toMatchObject({ id: "p1", name: "贪吃蛇游戏" });
    // The bug: without unwrapping, `.name` is undefined (the envelope has no
    // top-level name) and the board breadcrumb falls back to "项目未找到".
    expect(got.name).toBe("贪吃蛇游戏");
  });
});
