import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api } from "./api.js";

const TOKEN_KEY = "cogni_token";

export function useAuth() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const acceptUrls = (urls: string[] | null) => {
      if (disposed || !urls) return;
      for (const u of urls) {
        const t = readToken(u);
        if (t) {
          localStorage.setItem(TOKEN_KEY, t);
          setToken(t);
        }
      }
    };

    getCurrent().then(acceptUrls).catch((e) => console.warn("failed to read current deep link", e));
    const unlisten = onOpenUrl((urls) => {
      acceptUrls(urls);
    });
    return () => {
      disposed = true;
      unlisten.then((f) => f()).catch(() => undefined);
    };
  }, []);

  const login = () => {
    const url = `${api.cloudUrl}/auth/google/start?redirect=${encodeURIComponent("cogni://auth")}`;
    if (!isTauri()) {
      window.location.href = url;
      return;
    }
    return openUrl(url);
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
  };
  return { token, login, logout };
}

function readToken(url: string): string | null {
  try {
    return new URL(url).searchParams.get("token");
  } catch {
    return null;
  }
}
