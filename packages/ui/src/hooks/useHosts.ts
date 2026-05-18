import { useCallback, useEffect, useState } from "react";
import type { ApiClient, HostInfo } from "../transport/api.js";

/**
 * Settings → Hosts data hook. Loads the user's registered hosts on mount and
 * exposes `rename(id, name)` + `remove(id)` for the per-row pencil/trash
 * buttons in SettingsPage → Hosts tab (also reused by the multihost picker
 * in Track L).
 *
 * UI behaviour: mount shows a `loading` spinner, then renders one row per
 * host (name + status badge + last-seen). Rename PATCHes the new name and
 * refreshes; remove DELETEs and refreshes — both make the change visible
 * once the cloud confirms.
 */
export function useHosts(api: ApiClient) {
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.listHosts();
      setHosts(rows);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rename = useCallback(async (id: string, name: string) => {
    await api.renameHost(id, name);
    await refresh();
  }, [api, refresh]);

  const remove = useCallback(async (id: string) => {
    await api.removeHost(id);
    await refresh();
  }, [api, refresh]);

  return { hosts, loading, refresh, rename, remove };
}
