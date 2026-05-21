/**
 * PushNotifier — sends Web Push notifications to a user's installed PWAs when a
 * task reaches a state worth interrupting them for (done / reviewing / failed).
 *
 * Why this exists: the WebSocket path (ClientHub) only reaches clients with a
 * live socket. When the PWA is closed/backgrounded there's no socket, so the
 * only way to reach the phone is the OS push channel (APNs/FCM) brokered by the
 * browser's push service. This module is that bridge: look up the user's stored
 * push endpoints and POST an encrypted payload to each.
 *
 * Design choices:
 *   - Fire-and-forget. Callers `void notifier.notifyTaskStateChanged(task)` from
 *     the same place they broadcast a `task-event`; a push failure must never
 *     break the lifecycle, so everything here is internally try/caught.
 *   - We push regardless of live-WS presence (product decision): a buzz on the
 *     phone is wanted even if a desktop tab is open. Avoids fragile per-node
 *     presence logic.
 *   - Dead endpoints (push service returns 404/410 = "gone") are pruned so the
 *     table doesn't accumulate stale subscriptions.
 */
import webpush from "web-push";
import type { ProjectTask } from "@cogni/contract";
import type { AnyDb } from "../db/client.js";
import type { VapidConfig } from "../env.js";
import { getProject } from "../db/projects.js";
import {
  listPushSubscriptionsForUser,
  deletePushSubscriptionByEndpoint,
} from "../db/push-subscriptions.js";

export interface PushLogger {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
}

// Only these states are worth a notification (see AskUserQuestion product note
// in main.ts — needs-input rarely fires, so it's intentionally omitted).
const NOTIFY_STATES = new Set(["done", "reviewing", "failed"]);

interface NotificationCopy {
  title: string;
  body: string;
}

function copyFor(state: string, taskTitle: string, locale: string): NotificationCopy | null {
  const zh = locale.startsWith("zh");
  const title = taskTitle || (zh ? "未命名任务" : "Untitled task");
  switch (state) {
    case "done":
      return { title: zh ? "✅ 任务完成" : "✅ Task done", body: title };
    case "reviewing":
      return { title: zh ? "👀 等待你审查" : "👀 Needs your review", body: title };
    case "failed":
      return { title: zh ? "❌ 任务失败" : "❌ Task failed", body: title };
    default:
      return null;
  }
}

export class PushNotifier {
  private readonly db: AnyDb;
  private readonly log?: PushLogger;

  constructor(deps: { db: AnyDb; vapid: VapidConfig; logger?: PushLogger }) {
    this.db = deps.db;
    this.log = deps.logger;
    // Module-global VAPID identity. Single process, so setting it once is fine.
    webpush.setVapidDetails(deps.vapid.subject, deps.vapid.publicKey, deps.vapid.privateKey);
  }

  /** Notify the task owner's devices. Safe to call for any kind/state — it
   *  filters to the notify-worthy states itself and never throws. */
  async notifyTaskStateChanged(task: ProjectTask): Promise<void> {
    try {
      if (!NOTIFY_STATES.has(task.state)) return;

      const project = await getProject(this.db, task.projectId);
      if (!project) return;

      const subs = await listPushSubscriptionsForUser(this.db, project.userId);
      if (subs.length === 0) return;

      const url = `/projects/${task.projectId}`;
      await Promise.all(
        subs.map(async (sub) => {
          const copy = copyFor(task.state, task.title, sub.locale);
          if (!copy) return;
          const payload = JSON.stringify({
            title: copy.title,
            body: copy.body,
            url,
            // Collapse repeat notifications for the same task into one.
            tag: `task-${task.id}`,
          });
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              payload,
            );
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              // Subscription expired/unsubscribed — prune it.
              await deletePushSubscriptionByEndpoint(this.db, sub.endpoint).catch(() => {});
            } else {
              this.log?.warn?.({ err: String(err), status }, "web-push send failed");
            }
          }
        }),
      );
    } catch (err) {
      this.log?.warn?.({ err: String(err) }, "notifyTaskStateChanged failed");
    }
  }
}
