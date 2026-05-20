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
import type { ProjectTask, TaskRun, CloudToClient, Attachment } from "@cogni/contract";
import type { ApiClient, TaskDetailResponse } from "../transport/api.js";

export interface UseTaskDetailResult {
  task: ProjectTask | null;
  runs: TaskRun[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  reply: (content: string, attachments?: Attachment[]) => Promise<void>;
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
    // SWR seed: a cached task detail renders the drawer instantly on re-open;
    // otherwise reset to null/[] so we show the drawer's loading state rather
    // than the previously-opened card's content during the round-trip.
    const cached = api.cache.get<TaskDetailResponse>(`task:${taskId}`);
    setTask(cached?.task ?? null);
    setRuns(cached?.runs ?? []);
    setLoading(!cached);
    try {
      const detail = await api.getTaskDetail(taskId);
      api.cache.set(`task:${taskId}`, detail);
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
          api.cache.delete(`task:${taskId}`);
          setTask(null);
        } else {
          // Keep the cached envelope's task row in step with live updates so a
          // re-open shows the latest state. Runs are left as last fetched.
          const prev = api.cache.get<TaskDetailResponse>(`task:${taskId}`);
          api.cache.set(`task:${taskId}`, { task: frame.task, runs: prev?.runs ?? [] });
          setTask(frame.task);
        }
      },
    });
    return unsubscribe;
  }, [api, taskId]);

  const reply  = useCallback(async (content: string, attachments?: Attachment[]) => { await api.replyToTask(taskId, content, attachments); }, [api, taskId]);
  const accept = useCallback(async () => { await api.acceptTask(taskId); }, [api, taskId]);
  const reject = useCallback(async () => { await api.rejectTask(taskId); }, [api, taskId]);
  const retry  = useCallback(async () => { await api.retryTask(taskId); }, [api, taskId]);
  const cancel = useCallback(async () => { await api.cancelTask(taskId); }, [api, taskId]);

  return { task, runs, loading, error, refresh, reply, accept, reject, retry, cancel };
}
