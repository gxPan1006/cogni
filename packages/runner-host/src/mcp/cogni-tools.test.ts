import { describe, it, expect } from "vitest";
import { callCogniTool, httpBaseFromWsUrl } from "./cogni-tools.js";

describe("cogni-tools", () => {
  it("httpBaseFromWsUrl converts ws→http and wss→https", () => {
    expect(httpBaseFromWsUrl("ws://localhost:8787")).toBe("http://localhost:8787");
    expect(httpBaseFromWsUrl("wss://chat.ai-cognit.com")).toBe("https://chat.ai-cognit.com");
  });

  it("create_task POSTs to /api/projects/:id/tasks with Host auth", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchMock = (async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 201, json: async () => ({ id: "t1", title: "x" }) } as any;
    }) as unknown as typeof globalThis.fetch;
    const out = await callCogniTool(
      { fetch: fetchMock, config: { cloudUrl: "ws://localhost:8787", registrationToken: "tok", hostId: "h" } },
      "create_task",
      { projectId: "p1", title: "x" },
    );
    expect(calls[0]!.url).toBe("http://localhost:8787/api/projects/p1/tasks");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers.Authorization).toBe("Host tok");
    expect(out).toContain("t1");
  });

  it("delete_project DELETEs to /api/projects/:id", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchMock = (async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
    }) as unknown as typeof globalThis.fetch;
    await callCogniTool(
      { fetch: fetchMock, config: { cloudUrl: "ws://x", registrationToken: "t", hostId: "h" } },
      "delete_project",
      { projectId: "p9" },
    );
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("http://x/api/projects/p9");
  });

  it("non-ok responses surface an error envelope rather than throwing", async () => {
    const fetchMock = (async () =>
      ({ ok: false, status: 404, json: async () => ({ error: "not found" }) } as any)) as unknown as typeof globalThis.fetch;
    const out = await callCogniTool(
      { fetch: fetchMock, config: { cloudUrl: "ws://x", registrationToken: "t", hostId: "h" } },
      "delete_task",
      { taskId: "missing" },
    );
    const parsed = JSON.parse(out);
    expect(parsed.error).toBe(true);
    expect(parsed.status).toBe(404);
  });

  it("unknown tool throws", async () => {
    const fetchMock = (async () => ({}) as any) as unknown as typeof globalThis.fetch;
    await expect(
      callCogniTool(
        { fetch: fetchMock, config: { cloudUrl: "ws://x", registrationToken: "t", hostId: "h" } },
        "no_such_tool",
        {},
      ),
    ).rejects.toThrow(/unknown tool/);
  });

  it("startCogniMcpServer rejects when there is no host.json", async () => {
    const prev = process.env.COGNI_HOME;
    process.env.COGNI_HOME = "/tmp/cogni-nonexistent-" + Math.random().toString(36).slice(2);
    try {
      const { startCogniMcpServer } = await import("./cogni-tools.js");
      await expect(startCogniMcpServer()).rejects.toThrow(/host\.json/);
    } finally {
      if (prev === undefined) delete process.env.COGNI_HOME;
      else process.env.COGNI_HOME = prev;
    }
  });
});
