import { useEffect, useState } from "react";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./api.js";

const TOKEN_KEY = "cogni_token";

export function useAuth() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));

  useEffect(() => {
    const unlisten = onOpenUrl((urls) => {
      for (const u of urls) {
        const t = new URL(u).searchParams.get("token");
        if (t) {
          localStorage.setItem(TOKEN_KEY, t);
          setToken(t);
        }
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const login = () =>
    openUrl(`${api.cloudUrl}/auth/google/start?redirect=${encodeURIComponent("cogni://auth")}`);
  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
  };
  return { token, login, logout };
}
