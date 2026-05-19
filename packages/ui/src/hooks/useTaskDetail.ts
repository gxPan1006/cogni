/**
 * useTaskDetail — drawer view for one task.
 *
 * Composed of:
 *   - HTTP `GET /api/tasks/:id` for the {task, runs} envelope on mount
 *   - `subscribe-task:<taskId>` for `task-event` frames (kind: updated /
 *     state-changed / deleted) so the drawer's header / stepper / action
 *     row reflect the live task row.
 *   - The runner's event stream stays on the existing `event` channel,
 *     keyed by the task's `executionThreadId`. We do NOT subscribe to it
 *     here — TaskDetail is expected to render <Conversation> or compose
 *     `useThreadStream(api, task.executionThreadId)` itself once the task
 *     has one. This keeps the hook a clean state hook (no chat blocks).
 *
 * Action mutators (`reply` / `accept` / `reject` / `retry` / `cancel`) are
 * thin pass-throughs to the cloud HTTP routes; lifecycle state on the
 * server-side fans out via `task-event` push and lands here via the
 * subscription reducer. UI does not optimistically transition.
 */
import { useCallback, useEffect, useState } from "react";
import type { ProjectTask, TaskRun, CloudToClient } from "@cogni/contract";
import type { ApiClient } from "../transport/api.js";

export interface UseTaskDetailResult {
  task: ProjectTask | null;
  runs: TaskRun[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  reply: (content: string) => Promise<void>;
  accept: () => Promise<void>;
  reject: () => Promise<void>;
  retry: () => Promise<void>;
  cancel: () => Promise<void>;
}

export function useTaskDetail(api: ApiClient, taskId: string): UseTaskDetailResult {
  const [task, setTask] = useState<ProjectTask | null>(null);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const detail = await api.getTaskDetail(taskId);
      setTask(detail.task);
      setRuns(detail.runs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [api, taskId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const unsubscribe = api.wsClient.subscribeTask({
      taskId,
      onFrame: (frame: CloudToClient) => {
        if (frame.t !== "task-event") return;
        if (frame.task.id !== taskId) return;
        if (frame.kind === "deleted") {
          setTask(null);
        } else {
          setTask(frame.task);
        }
      },
    });
    return unsubscribe;
  }, [api, taskId]);

  const reply  = useCallback(async (content: string) => { await api.replyToTask(taskId, content); }, [api, taskId]);
  const accept = useCallback(async () => { await api.acceptTask(taskId); }, [api, taskId]);
  const reject = useCallback(async () => { await api.rejectTask(taskId); }, [api, taskId]);
  const retry  = useCallback(async () => { await api.retryTask(taskId); }, [api, taskId]);
  const cancel = useCallback(async () => { await api.cancelTask(taskId); }, [api, taskId]);

  return { task, runs, loading, error, refresh, reply, accept, reject, retry, cancel };
}
