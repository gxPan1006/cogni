/**
 * SP-4 Artifacts: browse + preview + download task/chat output files.
 *
 * Two sources share one viewer:
 *   - project: a single-level directory browser confined to the project's
 *     repoPath (descend into dirs, click files). Backed by
 *     `GET /api/projects/:id/browse` + `/file`.
 *   - chat: a flat list of files the runner Wrote/Edited this thread, from
 *     `GET /api/threads/:id/files` + `/file`.
 *
 * The viewer fetches the file as an auth'd Blob (the /api/* file endpoints
 * need a Bearer header, which a bare <iframe src> can't send), wraps it in an
 * object URL, and renders inline by type: HTML in a sandboxed iframe (so a
 * generated page actually runs/looks right), images in <img>, text/code/json
 * /markdown in <pre>; anything else is download-only. A download button is
 * always present.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../transport/api.js";
import "./artifacts.css";

interface Entry { name: string; type: "file" | "dir"; size?: number }
interface ChatFile { path: string; name: string }

export type ArtifactSource =
  // `startPath` (optional) opens the browser at a subdir under the project's
  // repoPath — e.g. a reviewing task's worktree, where the new files live
  // before they merge to main. Omit to start at repoPath (done tasks: files
  // are merged there). Must be under repoPath; the server confines it anyway.
  | { kind: "project"; projectId: string; startPath?: string }
  | { kind: "chat"; threadId: string };

interface SelectedFile {
  path: string;
  name: string;
  blobUrl: string;
  text: string | null; // populated for text-like previews
  kind: "html" | "image" | "text" | "binary";
}

const TEXT_EXT = new Set(["txt", "md", "css", "js", "mjs", "ts", "tsx", "jsx", "py", "json", "yaml", "yml", "sh", "toml", "xml", "csv"]);
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
function kindFor(name: string): SelectedFile["kind"] {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "html" || ext === "htm") return "html";
  if (IMG_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}

export function ArtifactBrowser({ api, source }: { api: ApiClient; source: ArtifactSource }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [chatFiles, setChatFiles] = useState<ChatFile[]>([]);
  const [cwd, setCwd] = useState<string>("");
  // Repo root, discovered from the first browse response (server defaults to
  // the project's repoPath when no ?path is given). Used to gate the ↑ button.
  const [root, setRoot] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  // Revoke the previous object URL whenever the selection changes / unmounts.
  useEffect(() => () => { if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current); }, []);

  const loadList = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      if (source.kind === "project") {
        const res = await api.browseProjectDir(source.projectId, path);
        setEntries(res.entries);
        setCwd(res.cwd);
        setRoot((r) => r || res.cwd); // first response defines the repo root
      } else {
        const res = await api.listThreadFiles(source.threadId);
        setChatFiles(res.files);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, source]);

  useEffect(() => {
    void loadList(source.kind === "project" ? source.startPath : undefined);
  }, [loadList, source]);

  const openFile = useCallback(async (path: string, name: string) => {
    setError(null);
    try {
      const blob = source.kind === "project"
        ? await api.fetchProjectFile(source.projectId, path)
        : await api.fetchThreadFile(source.threadId, path);
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      const blobUrl = URL.createObjectURL(blob);
      blobUrlRef.current = blobUrl;
      const kind = kindFor(name);
      const text = kind === "text" || kind === "html" ? await blob.text() : null;
      setSelected({ path, name, blobUrl, text, kind });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, source]);

  const download = useCallback((path: string, name: string) => {
    // Force-download regardless of preview type by appending download=1; we
    // still go through fetchBlob for auth, then synthesize an <a download>.
    void (async () => {
      try {
        const blob = source.kind === "project"
          ? await api.fetchProjectFile(source.projectId, path)
          : await api.fetchThreadFile(source.threadId, path);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = name; document.body.appendChild(a); a.click();
        a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [api, source]);

  const atRoot = source.kind === "project" && (cwd === root || root === "");
  const parentDir = cwd.includes("/") ? cwd.slice(0, cwd.lastIndexOf("/")) : cwd;

  return (
    <div className="artifacts">
      <div className="artifacts__list">
        {source.kind === "project" && (
          <div className="artifacts__crumb">
            <button className="btn btn-sm btn-ghost" disabled={atRoot} onClick={() => loadList(parentDir)}>↑ 上级</button>
            <span className="artifacts__cwd" title={cwd}>{cwd}</span>
          </div>
        )}
        {loading && <div className="artifacts__hint">加载中…</div>}
        {error && <div className="artifacts__error">{error}</div>}
        {!loading && source.kind === "project" && entries.length === 0 && (
          <div className="artifacts__hint">空目录</div>
        )}
        {!loading && source.kind === "chat" && chatFiles.length === 0 && (
          <div className="artifacts__hint">这个对话还没产生文件</div>
        )}
        {source.kind === "project" && entries.map((e) => (
          <div key={e.name} className="artifacts__row">
            {e.type === "dir" ? (
              <button className="artifacts__entry artifacts__entry--dir" onClick={() => loadList(`${cwd}/${e.name}`)}>
                📁 {e.name}
              </button>
            ) : (
              <>
                <button className="artifacts__entry" onClick={() => openFile(`${cwd}/${e.name}`, e.name)}>
                  📄 {e.name}{e.size != null ? <span className="artifacts__size">{fmtSize(e.size)}</span> : null}
                </button>
                <button className="artifacts__dl" title="下载" onClick={() => download(`${cwd}/${e.name}`, e.name)}>⬇</button>
              </>
            )}
          </div>
        ))}
        {source.kind === "chat" && chatFiles.map((f) => (
          <div key={f.path} className="artifacts__row">
            <button className="artifacts__entry" onClick={() => openFile(f.path, f.name)}>📄 {f.name}</button>
            <button className="artifacts__dl" title="下载" onClick={() => download(f.path, f.name)}>⬇</button>
          </div>
        ))}
      </div>

      <div className="artifacts__viewer">
        {!selected && <div className="artifacts__hint artifacts__hint--center">选一个文件预览</div>}
        {selected && (
          <>
            <div className="artifacts__viewer-head">
              <span className="artifacts__viewer-name">{selected.name}</span>
              <button className="btn btn-sm btn-ghost" onClick={() => download(selected.path, selected.name)}>下载</button>
            </div>
            <div className="artifacts__viewer-body">
              {selected.kind === "html" && (
                <iframe className="artifacts__iframe" title={selected.name} sandbox="allow-scripts allow-pointer-lock" srcDoc={selected.text ?? ""} />
              )}
              {selected.kind === "image" && (
                <img className="artifacts__img" src={selected.blobUrl} alt={selected.name} />
              )}
              {selected.kind === "text" && (
                <pre className="artifacts__pre">{selected.text}</pre>
              )}
              {selected.kind === "binary" && (
                <div className="artifacts__hint artifacts__hint--center">二进制文件,点上方"下载"获取</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return ` ${n} B`;
  if (n < 1024 * 1024) return ` ${(n / 1024).toFixed(1)} KB`;
  return ` ${(n / 1024 / 1024).toFixed(1)} MB`;
}
