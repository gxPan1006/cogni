/**
 * @vitest-environment node
 *
 * Reducer-focused tests for useProjectBoard. See useProjects.test.ts for the
 * rationale on not mounting the hook in a renderer.
 */
import { describe, expect, it, vi } from "vitest";
import type { ProjectTask } from "@cogni/contract";
import { applyTaskEvent } from "./useProjectBoard.js";

function mkTask(id: string, overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id, projectId: "pX", ref: id, title: id, description: null,
    state: "queued", priority: 3, labels: [], orderIndex: "1",
    hostId: null, adapter: null, worktreePath: null, branchName: null,
    executionThreadId: null, retries: 0, maxRetries: 3, needsInputWhat: null,
    createdAt: "2026-05-19T00:00:00Z", updatedAt: "2026-05-19T00:00:00Z",
    startedAt: null, completedAt: null,
    ...overrides,
  };
}

describe("applyTaskEvent — board reducer", () => {
  it("prepends on 'created' (board shows newest first)", () => {
    const cur = [mkTask("T1"), mkTask("T2")];
    const next = applyTaskEvent(cur, { t: "task-event", kind: "created", task: mkTask("T3") });
    expect(next.map((t) => t.id)).toEqual(["T3", "T1", "T2"]);
  });

  it("de-dupes 'created' frames matching an existing id", () => {
    const cur = [mkTask("T1"), mkTask("T2")];
    const next = applyTaskEvent(cur, { t: "task-event", kind: "created", task: mkTask("T1") });
    expect(next).toBe(cur);
  });

  it("replaces in place on 'state-changed'", () => {
    const cur = [mkTask("T1", { state: "queued" }), mkTask("T2")];
    const next = applyTaskEvent(cur, {
      t: "task-event", kind: "state-changed", task: mkTask("T1", { state: "running" }),
    });
    expect(next.map((t) => t.id)).toEqual(["T1", "T2"]);
    expect(next[0]!.state).toBe("running");
  });

  it("removes on 'deleted'", () => {
    const cur = [mkTask("T1"), mkTask("T2"), mkTask("T3")];
    const next = applyTaskEvent(cur, { t: "task-event", kind: "deleted", task: mkTask("T2") });
    expect(next.map((t) => t.id)).toEqual(["T1", "T3"]);
  });

  it("'updated' on an unknown id is a no-op (no insertion)", () => {
    const cur = [mkTask("T1")];
    const next = applyTaskEvent(cur, { t: "task-event", kind: "updated", task: mkTask("T99") });
    expect(next).toEqual(cur);
  });
});

describe("useProjectBoard — api wrapper integration", () => {
  it("createTask delegates to api.createProjectTask", async () => {
    const created = { id: "T-new", projectId: "pX" } as ProjectTask;
    const api = { createProjectTask: vi.fn().mockResolvedValue(created) };
    const out = await api.createProjectTask("pX", { title: "n" });
    expect(api.createProjectTask).toHaveBeenCalledWith("pX", { title: "n" });
    expect(out).toBe(created);
  });
});
