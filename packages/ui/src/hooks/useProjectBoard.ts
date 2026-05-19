/**
 * useProjectBoard — one project's board page.
 *
 * Composed of: HTTP `GET /api/projects/:id` + `GET /api/projects/:id/tasks`
 * on mount + two WS subscriptions:
 *
 *   - `subscribe-project:<projectId>` for `task-event` frames (any kind:
 *     created / updated / deleted / state-changed). This is how columns /
 *     swarm / timeline views see new cards appear, state pills change,
 *     `needs-input` badges light up, etc.
 *   - `subscribe-projects` for `project-event(updated|archived)` of the
 *     project itself — covers the user editing the project's settings in a
 *     second tab while the board is open here.
 *
 * `createTask` is exposed so NewTask modal callers don't need direct `api`
 * access. Like useProjects.createProject, it relies on the WS frame for the
 * canonical insert; it returns the created task so the caller can navigate
 * to it directly.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Project, ProjectTask, CloudToClient } from "@cogni/contract";
import type { ApiClient, CreateTaskInput } from "../transport/api.js";

/**
 * Pure reducer for `task-event` frames scoped to one project. Exported for
 * tests; the hook applies it inside its WS handler.
 */
export function applyTaskEvent(
  cur: ProjectTask[],
  frame: Extract<CloudToClient, { t: "task-event" }>,
): ProjectTask[] {
  if (frame.kind === "created") {
    if (cur.some((t) => t.id === frame.task.id)) return cur;
    return [frame.task, ...cur];
  }
  if (frame.kind === "deleted") {
    return cur.filter((t) => t.id !== frame.task.id);
  }
  // updated | state-changed
  return cur.map((t) => (t.id === frame.task.id ? frame.task : t));
}

export interface UseProjectBoardResult {
  project: Project | null;
  tasks: ProjectTask[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  createTask: (input: CreateTaskInput) => Promise<ProjectTask>;
}

export function useProjectBoard(api: ApiClient, projectId: string): UseProjectBoardResult {
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  const tasksRef = useRef<ProjectTask[]>([]);
  tasksRef.current = tasks;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [p, ts] = await Promise.all([
        api.getProject(projectId),
        api.listProjectTasks(projectId),
      ]);
      setProject(p);
      setTasks(ts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [api, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Board-scoped task-event reducer.
  useEffect(() => {
    const ws = api.wsClient;
    const unsubTasks = ws.subscribeProject({
      projectId,
      onFrame: (frame: CloudToClient) => {
        if (frame.t !== "task-event") return;
        setTasks(applyTaskEvent(tasksRef.current, frame));
      },
    });

    // Cover project-level changes (rename, archive, concurrency change in
    // another tab) for the breadcrumb / toolbar.
    const unsubProjects = ws.subscribeProjects({
      onFrame: (frame: CloudToClient) => {
        if (frame.t !== "project-event") return;
        if (frame.project.id !== projectId) return;
        setProject(frame.project);
      },
    });

    return () => {
      unsubTasks();
      unsubProjects();
    };
  }, [api, projectId]);

  const createTask = useCallback(async (input: CreateTaskInput): Promise<ProjectTask> => {
    const created = await api.createProjectTask(projectId, input);
    setTasks((prev) => (prev.some((t) => t.id === created.id) ? prev : [created, ...prev]));
    return created;
  }, [api, projectId]);

  return { project, tasks, loading, error, refresh, createTask };
}
