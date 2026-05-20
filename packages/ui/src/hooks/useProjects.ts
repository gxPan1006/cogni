/**
 * useProjects — user's whole project list.
 *
 * Composed of: one HTTP `GET /api/projects` on mount + a long-lived
 * `subscribe-projects` WS subscription that pushes `project-event` frames
 * (kind: "created" | "updated" | "archived"). Each frame is reduced into the
 * local list so the sidebar and main-area list stay in sync across:
 *   - Tabs / app instances of the same user (Sidebar reflects creates from web)
 *   - Background lifecycle changes (project archived from settings → sidebar
 *     row dims immediately without a refresh)
 *
 * The hook is intentionally read-mostly; it exposes thin `createProject` /
 * `archiveProject` mutators so page-level UIs (Shell, web App) don't have to
 * thread `api` around as well. The mutators await the cloud response and
 * rely on the same `project-event` push for state — they do NOT optimistically
 * mutate the local list, which keeps the source of truth single.
 *
 * Visible behaviour:
 *   - Mount → spinner-friendly `loading=true` until first HTTP returns.
 *   - WS frame `project-event(created)` → new card appears in <ProjectsList> /
 *     new row in Sidebar (no refresh).
 *   - `project-event(archived)` → row moves into the collapsed "已归档" section.
 *   - `createProject(...)` resolves with the new project; UI typically uses it
 *     to immediately navigate into the empty board.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Project, CloudToClient } from "@cogni/contract";
import type { ApiClient, CreateProjectInput } from "../transport/api.js";

/**
 * Pure reducer for `project-event` frames. Exported separately so unit tests
 * can pin down merge behaviour without spinning up a React renderer. The
 * hook below applies it inside its WS handler with `setProjects(merge…)`.
 */
export function applyProjectEvent(
  cur: Project[],
  frame: Extract<CloudToClient, { t: "project-event" }>,
): Project[] {
  if (frame.kind === "created") {
    if (cur.some((p) => p.id === frame.project.id)) return cur;
    return [frame.project, ...cur];
  }
  // updated | archived both project the full row; replace in place to keep
  // ordering stable (no jump on archive — the `archivedAt` field flips and
  // UI presentation moves the card to the archived section visually).
  return cur.map((p) => (p.id === frame.project.id ? frame.project : p));
}

export interface UseProjectsResult {
  projects: Project[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  createProject: (input: CreateProjectInput) => Promise<Project>;
  archiveProject: (id: string) => Promise<void>;
}

export function useProjects(api: ApiClient): UseProjectsResult {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  // Latest state captured in a ref so the WS frame handler reduces against
  // the live list without re-binding when state changes.
  const projectsRef = useRef<Project[]>([]);
  projectsRef.current = projects;

  const refresh = useCallback(async () => {
    // SWR seed: show the last-known list synchronously so re-mounting the list
    // (e.g. navigating back from a board) doesn't flash the skeleton grid.
    const cached = api.cache.get<Project[]>("projects");
    if (cached) setProjects(cached);
    setLoading(!cached);
    try {
      const rows = await api.listProjects();
      api.cache.set("projects", rows);
      setProjects(rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live updates — `project-event` reducer.
  useEffect(() => {
    const ws = api.wsClient;
    const unsubscribe = ws.subscribeProjects({
      onFrame: (frame: CloudToClient) => {
        if (frame.t !== "project-event") return;
        const next = applyProjectEvent(projectsRef.current, frame);
        api.cache.set("projects", next);
        setProjects(next);
      },
    });
    return unsubscribe;
  }, [api]);

  const createProject = useCallback(async (input: CreateProjectInput): Promise<Project> => {
    const created = await api.createProject(input);
    // Optimistically prepend so the UI advances even before the WS push lands.
    // The WS handler above de-dupes by id.
    setProjects((prev) => {
      const next = prev.some((p) => p.id === created.id) ? prev : [created, ...prev];
      api.cache.set("projects", next);
      return next;
    });
    return created;
  }, [api]);

  const archiveProject = useCallback(async (id: string) => {
    await api.archiveProject(id);
    // No optimistic mutation — the WS push will mark `archivedAt`. If that
    // doesn't arrive (cloud bug), `refresh()` recovers.
  }, [api]);

  return { projects, loading, error, refresh, createProject, archiveProject };
}
