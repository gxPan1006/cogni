import { useCallback, useState } from "react";

export interface UploadItem {
  /** Stable client id for list keys. */
  localId: string;
  file: File;
  status: "uploading" | "done" | "error";
  progress: number; // 0..1
  /** Host's final name once committed (may differ from file.name after de-dupe). */
  name?: string;
  size?: number;
  error?: string;
}

export interface UseUploads {
  items: UploadItem[];
  /** True while any item is still uploading — composer disables send. */
  busy: boolean;
  add: (files: FileList | File[]) => void;
  remove: (localId: string) => void;
  retry: (localId: string) => void;
  /** Committed attachments for the `send` frame, then clears the tray. */
  takeAttachments: () => { name: string; size: number }[];
  reset: () => void;
}

/**
 * Composer upload tray. `uploadFn` is `api.uploadFile` bound to the active
 * threadId by the caller (chat: the open thread; task reply: executionThreadId).
 */
export function useUploads(
  uploadFn: (file: File, onProgress: (f: number) => void) => Promise<{ name: string; size: number }>,
): UseUploads {
  const [items, setItems] = useState<UploadItem[]>([]);

  const patch = useCallback((localId: string, p: Partial<UploadItem>) => {
    setItems((prev) => prev.map((it) => (it.localId === localId ? { ...it, ...p } : it)));
  }, []);

  const run = useCallback((localId: string, file: File) => {
    uploadFn(file, (f) => patch(localId, { progress: f }))
      .then((res) => patch(localId, { status: "done", progress: 1, name: res.name, size: res.size }))
      .catch((err) => patch(localId, { status: "error", error: String(err) }));
  }, [uploadFn, patch]);

  const add = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files);
    const next: UploadItem[] = arr.map((file) => ({
      localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file, status: "uploading", progress: 0,
    }));
    setItems((prev) => [...prev, ...next]);
    for (const it of next) run(it.localId, it.file);
  }, [run]);

  const remove = useCallback((localId: string) => {
    setItems((prev) => prev.filter((it) => it.localId !== localId));
  }, []);

  const retry = useCallback((localId: string) => {
    setItems((prev) => {
      const it = prev.find((x) => x.localId === localId);
      if (it) run(localId, it.file);
      return prev.map((x) => (x.localId === localId ? { ...x, status: "uploading", progress: 0, error: undefined } : x));
    });
  }, [run]);

  const takeAttachments = useCallback(() => {
    const done = items.filter((it) => it.status === "done" && it.name && it.size != null);
    setItems([]);
    return done.map((it) => ({ name: it.name!, size: it.size! }));
  }, [items]);

  const reset = useCallback(() => setItems([]), []);

  const busy = items.some((it) => it.status === "uploading");
  return { items, busy, add, remove, retry, takeAttachments, reset };
}
