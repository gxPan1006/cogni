import { useCallback, useEffect, useState } from "react";
import type { ApiClient, IdentityRow } from "../transport/api.js";

/**
 * Settings → Identities data hook. Loads the linked auth identities (Google
 * accounts, verified emails) on mount and exposes `remove(kind, sub)` for the
 * per-row "Unlink" button in SettingsPage → Identities tab.
 *
 * UI behaviour: mount shows a `loading` spinner, then renders one row per
 * identity (kind badge + `sub`). Unlink fires a DELETE keyed by
 * `(kind, sub)` then `refresh()` so the row disappears on success.
 */
export function useIdentities(api: ApiClient) {
  const [identities, setIdentities] = useState<IdentityRow[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.listIdentities();
      setIdentities(rows);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = useCallback(async (kind: string, sub: string) => {
    await api.deleteIdentity(kind, sub);
    await refresh();
  }, [api, refresh]);

  return { identities, loading, refresh, remove };
}
