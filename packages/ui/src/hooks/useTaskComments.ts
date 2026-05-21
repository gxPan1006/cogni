/**
 * useTaskComments — the 主页面 comment feed for one task.
 *
 * Initial REST fetch + live `task-comment` deltas over the existing
 * `subscribe-task:<taskId>` channel (same channel useTaskDetail uses for
 * `task-event`). Posting a comment is inert server-side (no lifecycle
 * change); the new card lands via the WS echo, so we don't optimistically
 * insert. Deletes likewise reconcile via the `deleted` frame.
 */
import { useCallback, useEffect, useState } from "react";
import type { TaskComment, CloudToClient } from "@cogni/contract";
import type { ApiClient } from "../transport/api.js";

export interface UseTaskCommentsResult {
  comments: TaskComment[];
  loading: boolean;
  add: (body: string, attachments?: { name: string; size: number }[]) => Promise<void>;
  remove: (commentId: string) => Promise<void>;
}

export function useTaskComments(api: ApiClient, taskId: string): UseTaskCommentsResult {
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    // SWR seed: a cached feed renders instantly on re-open; otherwise show
    // the loading state during the round-trip.
    const cached = api.cache.get<TaskComment[]>(`task-comments:${taskId}`);
    setComments(cached ?? []);
    setLoading(!cached);
    try {
      const list = await api.getTaskComments(taskId);
      api.cache.set(`task-comments:${taskId}`, list);
      setComments(list);
    } finally {
      setLoading(false);
    }
  }, [api, taskId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const unsubscribe = api.wsClient.subscribeTask({
      taskId,
      onFrame: (frame: CloudToClient) => {
        if (frame.t !== "task-comment") return;
        if (frame.comment.taskId !== taskId) return;
        setComments((prev) => {
          let next: TaskComment[];
          if (frame.kind === "deleted") {
            next = prev.filter((c) => c.id !== frame.comment.id);
          } else if (prev.some((c) => c.id === frame.comment.id)) {
            next = prev.map((c) => (c.id === frame.comment.id ? frame.comment : c));
          } else {
            next = [...prev, frame.comment].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          }
          api.cache.set(`task-comments:${taskId}`, next);
          return next;
        });
      },
    });
    return unsubscribe;
  }, [api, taskId]);

  const add = useCallback(async (body: string, attachments?: { name: string; size: number }[]) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    await api.addTaskComment(taskId, trimmed, attachments);
  }, [api, taskId]);

  const remove = useCallback(async (commentId: string) => {
    await api.deleteTaskComment(taskId, commentId);
  }, [api, taskId]);

  return { comments, loading, add, remove };
}
