import { useCallback, useEffect, useState } from "react";
import type { ApiClient, DeviceRow } from "../transport/api.js";

/**
 * Settings → Devices data hook. Loads the user's auth sessions on mount and
 * exposes `revoke(id)` for the "Sign out other device" button (the row's
 * trash-can icon in SettingsPage → Devices tab).
 *
 * UI behaviour: mount shows a `loading` spinner, then renders the device list
 * (name, last-seen, "current" badge on `isCurrent`). Clicking revoke fires a
 * DELETE then `refresh()` so the row disappears once the cloud confirms.
 */
export function useDevices(api: ApiClient) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.listDevices();
      setDevices(rows);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const revoke = useCallback(async (id: string) => {
    await api.revokeDevice(id);
    await refresh();
  }, [api, refresh]);

  return { devices, loading, refresh, revoke };
}
