import { useCallback, useEffect, useState } from "react";
import type { ApiClient, UserProfile } from "../transport/api.js";

/**
 * Loads the signed-in user's editable profile (name + avatar) from `/api/me`.
 *
 * UI behaviour: the sidebar / account page paint instantly from the
 * JWT-derived email; this hook fetches the real name/avatar a moment later and
 * the host overlays it (no visible reload). `update` PATCHes then refreshes so
 * the new name/avatar appears everywhere bound to this client.
 */
export function useMe(api: ApiClient) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setProfile(await api.getMe());
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  const update = useCallback(async (patch: { name?: string | null; avatar?: string | null }) => {
    const next = await api.updateProfile(patch);
    setProfile(next);
    return next;
  }, [api]);

  return { profile, loading, refresh, update };
}
