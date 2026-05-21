import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProjectTask } from "@cogni/contract";

// web-push + the two db modules are mocked so we can assert the notifier's
// fan-out / filtering / pruning logic without a live push service or DB.
const h = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
  getProject: vi.fn(),
  listPushSubscriptionsForUser: vi.fn(),
  deletePushSubscriptionByEndpoint: vi.fn(),
}));

vi.mock("web-push", () => ({ default: { setVapidDetails: h.setVapidDetails, sendNotification: h.sendNotification } }));
vi.mock("../db/projects.js", () => ({ getProject: h.getProject }));
vi.mock("../db/push-subscriptions.js", () => ({
  listPushSubscriptionsForUser: h.listPushSubscriptionsForUser,
  deletePushSubscriptionByEndpoint: h.deletePushSubscriptionByEndpoint,
}));

import { PushNotifier } from "./notifier.js";

const VAPID = { publicKey: "pub", privateKey: "priv", subject: "mailto:a@b.c" };

function makeTask(over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "task-1",
    projectId: "proj-1",
    state: "done",
    title: "Ship the thing",
    ...over,
  } as unknown as ProjectTask;
}

function sub(over: Partial<{ endpoint: string; locale: string }> = {}) {
  return {
    id: "s",
    userId: "u1",
    endpoint: over.endpoint ?? "https://push/1",
    p256dh: "p",
    auth: "a",
    locale: over.locale ?? "en",
    userAgent: null,
    createdAt: new Date(),
  };
}

describe("PushNotifier", () => {
  let notifier: PushNotifier;

  beforeEach(() => {
    vi.clearAllMocks();
    h.getProject.mockResolvedValue({ id: "proj-1", userId: "u1" });
    h.sendNotification.mockResolvedValue(undefined);
    notifier = new PushNotifier({ db: {} as never, vapid: VAPID });
  });

  it("sets VAPID identity on construction", () => {
    expect(h.setVapidDetails).toHaveBeenCalledWith("mailto:a@b.c", "pub", "priv");
  });

  it("pushes to every subscription on a 'done' task with localized copy", async () => {
    h.listPushSubscriptionsForUser.mockResolvedValue([
      sub({ endpoint: "https://push/en", locale: "en" }),
      sub({ endpoint: "https://push/zh", locale: "zh" }),
    ]);

    await notifier.notifyTaskStateChanged(makeTask({ state: "done" }));

    expect(h.sendNotification).toHaveBeenCalledTimes(2);
    const payloads = h.sendNotification.mock.calls.map(([s, body]) => ({
      endpoint: (s as { endpoint: string }).endpoint,
      ...JSON.parse(body as string),
    }));
    const en = payloads.find((p) => p.endpoint === "https://push/en");
    const zh = payloads.find((p) => p.endpoint === "https://push/zh");
    expect(en.title).toContain("Task done");
    expect(zh.title).toContain("任务完成");
    expect(en.body).toBe("Ship the thing");
    expect(en.url).toBe("/projects/proj-1");
    expect(en.tag).toBe("task-task-1");
  });

  it.each(["queued", "running", "needs-input", "dispatching"])(
    "does NOT push for non-notify state %s",
    async (state) => {
      h.listPushSubscriptionsForUser.mockResolvedValue([sub()]);
      await notifier.notifyTaskStateChanged(makeTask({ state: state as ProjectTask["state"] }));
      expect(h.sendNotification).not.toHaveBeenCalled();
    },
  );

  it.each(["done", "reviewing", "failed"])("pushes for notify state %s", async (state) => {
    h.listPushSubscriptionsForUser.mockResolvedValue([sub()]);
    await notifier.notifyTaskStateChanged(makeTask({ state: state as ProjectTask["state"] }));
    expect(h.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("prunes a subscription when the push service reports it gone (410)", async () => {
    h.listPushSubscriptionsForUser.mockResolvedValue([sub({ endpoint: "https://push/dead" })]);
    h.sendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));

    await notifier.notifyTaskStateChanged(makeTask({ state: "done" }));

    expect(h.deletePushSubscriptionByEndpoint).toHaveBeenCalledWith({}, "https://push/dead");
  });

  it("does NOT prune on a transient (500) send failure", async () => {
    h.listPushSubscriptionsForUser.mockResolvedValue([sub()]);
    h.sendNotification.mockRejectedValue(Object.assign(new Error("boom"), { statusCode: 500 }));
    await notifier.notifyTaskStateChanged(makeTask({ state: "done" }));
    expect(h.deletePushSubscriptionByEndpoint).not.toHaveBeenCalled();
  });

  it("no-ops (no throw) when the user has no subscriptions", async () => {
    h.listPushSubscriptionsForUser.mockResolvedValue([]);
    await expect(notifier.notifyTaskStateChanged(makeTask({ state: "done" }))).resolves.toBeUndefined();
    expect(h.sendNotification).not.toHaveBeenCalled();
  });

  it("no-ops when the project can't be resolved", async () => {
    h.getProject.mockResolvedValue(null);
    await notifier.notifyTaskStateChanged(makeTask({ state: "done" }));
    expect(h.listPushSubscriptionsForUser).not.toHaveBeenCalled();
  });
});
