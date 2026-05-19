import { describe, it, expect, vi } from "vitest";
import { ClientHub } from "../../client-hub.js";
import type { Project, ProjectTask } from "@cogni/contract";

const PROJECT: Project = {
  id: "p1", tenantId: "t1", userId: "u1", name: "P",
  description: null, repoPath: "/r", defaultHostId: "h1",
  threadId: null, mergePolicy: "require-review", testCommand: null,
  concurrencyLimit: 2, systemPrompt: null, archivedAt: null,
  createdAt: "2026-05-19T00:00:00Z", updatedAt: "2026-05-19T00:00:00Z",
};
const TASK: ProjectTask = {
  id: "task1", projectId: "p1", ref: "T-1", title: "x", description: null,
  state: "queued", priority: 0, labels: [], orderIndex: "1",
  hostId: null, adapter: null, worktreePath: null, branchName: null,
  executionThreadId: null, retries: 0, maxRetries: 3, needsInputWhat: null,
  createdAt: "2026-05-19T00:00:00Z", updatedAt: "2026-05-19T00:00:00Z",
  startedAt: null, completedAt: null,
};

describe("ClientHub SP-3 project subscriptions", () => {
  it("broadcastProjects only hits clients subscribed for that userId", () => {
    const hub = new ClientHub();
    const a = vi.fn(); const b = vi.fn(); const c = vi.fn();
    hub.register({ clientId: "ca", userId: "u1", send: a });
    hub.register({ clientId: "cb", userId: "u1", send: b });
    hub.register({ clientId: "cc", userId: "u2", send: c });
    hub.subscribeProjects("ca", "u1");
    hub.subscribeProjects("cc", "u2");
    hub.broadcastProjects("u1", { t: "project-event", kind: "created", project: PROJECT });
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled(); // not subscribed
    expect(c).not.toHaveBeenCalled(); // different user's channel
  });

  it("broadcastProject only hits clients subscribed to that projectId", () => {
    const hub = new ClientHub();
    const a = vi.fn(); const b = vi.fn();
    hub.register({ clientId: "ca", userId: "u1", send: a });
    hub.register({ clientId: "cb", userId: "u1", send: b });
    hub.subscribeProject("ca", "p1");
    hub.subscribeProject("cb", "p2");
    hub.broadcastProject("p1", { t: "task-event", kind: "created", task: TASK });
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it("broadcastTask only hits clients subscribed to that taskId", () => {
    const hub = new ClientHub();
    const a = vi.fn(); const b = vi.fn();
    hub.register({ clientId: "ca", userId: "u1", send: a });
    hub.register({ clientId: "cb", userId: "u1", send: b });
    hub.subscribeTask("ca", "task1");
    hub.subscribeTask("cb", "task2");
    hub.broadcastTask("task1", { t: "task-event", kind: "updated", task: TASK });
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it("unregister sweeps all three project-domain subscription sets", () => {
    const hub = new ClientHub();
    const send = vi.fn();
    hub.register({ clientId: "c", userId: "u1", send });
    hub.subscribeProjects("c", "u1");
    hub.subscribeProject("c", "p1");
    hub.subscribeTask("c", "task1");
    hub.unregister("c");
    // Subsequent broadcasts should not crash and should reach nobody.
    hub.broadcastProjects("u1", { t: "project-event", kind: "updated", project: PROJECT });
    hub.broadcastProject("p1", { t: "task-event", kind: "updated", task: TASK });
    hub.broadcastTask("task1", { t: "task-event", kind: "updated", task: TASK });
    expect(send).not.toHaveBeenCalled();
  });

  it("subscribeProjects/subscribeProject/subscribeTask ignore unknown clientId (defensive)", () => {
    const hub = new ClientHub();
    // No client registered.
    hub.subscribeProjects("ghost", "u1");
    hub.subscribeProject("ghost", "p1");
    hub.subscribeTask("ghost", "task1");
    // Now register a real client and verify it still works.
    const send = vi.fn();
    hub.register({ clientId: "real", userId: "u1", send });
    hub.subscribeProject("real", "p1");
    hub.broadcastProject("p1", { t: "task-event", kind: "created", task: TASK });
    expect(send).toHaveBeenCalledOnce();
  });

  it("unsubscribeXxx is idempotent and scoped", () => {
    const hub = new ClientHub();
    const send = vi.fn();
    hub.register({ clientId: "c", userId: "u1", send });
    hub.subscribeProject("c", "p1");
    hub.subscribeProject("c", "p2");
    hub.unsubscribeProject("c", "p1");
    hub.unsubscribeProject("c", "p1"); // no-op
    hub.broadcastProject("p1", { t: "task-event", kind: "updated", task: TASK });
    hub.broadcastProject("p2", { t: "task-event", kind: "updated", task: TASK });
    // Only the p2 broadcast hit.
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not interfere with SP-2 thread/list subscriptions", () => {
    const hub = new ClientHub();
    const send = vi.fn();
    hub.register({ clientId: "c", userId: "u1", send });
    hub.subscribeList("c");
    hub.subscribe("c", "th1");
    hub.subscribeProject("c", "p1");
    // SP-2 thread broadcast still hits.
    hub.broadcast("th1", { t: "host-status", online: true });
    // SP-2 list-meta still hits.
    hub.publishThreadMeta("u1", { threadId: "th1", title: "x", lastMsgAt: "2026-01-01T00:00:00Z" });
    // SP-3 broadcast hits.
    hub.broadcastProject("p1", { t: "task-event", kind: "created", task: TASK });
    expect(send.mock.calls.map((c) => c[0].t)).toEqual(["host-status", "thread-meta", "task-event"]);
  });
});
