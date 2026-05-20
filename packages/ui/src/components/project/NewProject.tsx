/**
 * NewProject — modal for creating a project.
 *
 * (Shared component lifted from apps/desktop/src/NewProject.tsx; web uses it
 * too. Visual treatment unchanged. Two real changes vs the SP-1 mock version:)
 *
 *   1. `hosts` comes from `useHosts(api)` instead of `MOCK_HOSTS`. The default
 *      host dropdown lists the user's registered hosts; if none are online
 *      a disabled state nudges the user to pair one first.
 *   2. **Web step**: when `onBrowseHost` is provided, a "📁 浏览该 host"
 *      button appears next to the `repoPath` input. Clicking opens an inline
 *      directory picker (host's `fs-browse` RPC) so the user can pick a
 *      folder by name instead of typing an absolute path they may not know.
 *      Desktop omits this (it can use the native folder picker via tauri).
 *
 * `onCreate(draft)` is fired with all fields. The host (Shell/App) is
 * expected to call `useProjects().createProject(...)` then navigate into
 * the new project. The modal closes itself on submit (parent controls
 * mount via `onClose`).
 *
 * Cogni's project model is intentionally repo + host + supervision policy;
 * it does not ask users to classify work by external tracker/source.
 */
import { useEffect, useState } from "react";
import type { MergePolicy } from "@cogni/contract";
import type { HostInfo } from "../../transport/api.js";
import { Icon } from "../icons.js";
import { LoadingRows, LoadingState } from "../LoadingState.js";
import { suggestRepoPath } from "./new-project-path.js";
import "./new-project.css";

export interface NewProjectDraft {
  name: string;
  description: string;
  repoPath: string;
  defaultHostId: string;
  concurrencyLimit: number;
  systemPrompt: string;
  mergePolicy: MergePolicy;
  /** Ask the host to `git init` the repoPath if it isn't already a repo. */
  initRepo: boolean;
}

/** Result type for the directory browser callback used by web. */
export interface BrowseEntry { name: string; type: "file" | "dir" }
export interface BrowseResponse { entries: BrowseEntry[]; cwd: string }

export function NewProject({
  hosts,
  onClose,
  onCreate,
  onBrowseHost,
}: {
  hosts: HostInfo[];
  onClose: () => void;
  onCreate?: (draft: NewProjectDraft) => void;
  /**
   * Optional remote host folder browser. When provided (web only), the
   * repoPath row shows a "浏览" button that pops an inline picker which
   * calls this for every navigation step.
   */
  onBrowseHost?: (hostId: string, path?: string) => Promise<BrowseResponse>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [defaultHostId, setDefaultHostId] = useState(hosts[0]?.id ?? "");
  const [repoPath, setRepoPath] = useState("");
  const [concurrencyLimit, setConcurrencyLimit] = useState(2);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [mergePolicy, setMergePolicy] = useState<MergePolicy>("require-review");
  const [initRepo, setInitRepo] = useState(true);
  const [browseOpen, setBrowseOpen] = useState(false);
  /** True once the user hand-edits / browse-picks the path — stops auto-suggest from clobbering it. */
  const [pathDirty, setPathDirty] = useState(false);

  // Pre-fill the repo path from the selected host's projects-root while the
  // user hasn't touched it: <root>/<sanitized name>. Recomputes as they type
  // the name or switch hosts; stops once they edit the path themselves.
  // As the (async) host list loads or refreshes, keep a valid host selected —
  // prefer an online one so its projects-root is fresh. Without this, a modal
  // mounted before hosts arrived keeps defaultHostId="" and never pre-fills.
  // Respects a manual pick: only re-selects when the current one is empty/gone.
  useEffect(() => {
    if (hosts.length === 0) return;
    if (defaultHostId && hosts.some((h) => h.id === defaultHostId)) return;
    const pick = hosts.find((h) => h.status === "online") ?? hosts[0];
    if (pick) setDefaultHostId(pick.id);
  }, [hosts, defaultHostId]);

  const selectedHost = hosts.find((h) => h.id === defaultHostId);
  useEffect(() => {
    if (pathDirty) return;
    setRepoPath(suggestRepoPath(selectedHost?.projectsRoot, name));
  }, [name, selectedHost?.projectsRoot, pathDirty]);

  // When the selected host reports a projects-root, make the placeholder
  // illustrative — `<root>/<项目名>` — so the user sees where a new project
  // will land even before typing a name (the field stays empty until then).
  const repoPathPlaceholder = selectedHost?.projectsRoot
    ? `${selectedHost.projectsRoot.replace(/\/+$/, "")}/<项目名>`
    : "/Users/you/code/myapp";

  const canSubmit =
    name.trim().length > 0 &&
    repoPath.trim().length > 0 &&
    defaultHostId.length > 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal np" onClick={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <div>
            <div className="modal__eyebrow">新建</div>
            <h2 className="modal__title">新项目</h2>
          </div>
          <button className="modal__close" onClick={onClose} title="关闭 (Esc)">{Icon.x}</button>
        </header>

        <div className="modal__body">
          <Field label="名字" required hint="一句话能说出这个项目做什么">
            <input className="input" placeholder="例:SP-2 多端同步" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>

          <Field label="描述" hint="可选">
            <textarea className="input np__textarea" placeholder="给一两句话上下文,会进 system prompt" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </Field>

          <Field label="默认 host" required hint="新任务首先尝试在这台机器上跑">
            <select className="input" value={defaultHostId} onChange={(e) => setDefaultHostId(e.target.value)}>
              {hosts.length === 0 && <option value="">(还没注册 host)</option>}
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}{h.status === "offline" ? " · 离线" : ""}
                </option>
              ))}
            </select>
          </Field>

          <Field label="代码仓库路径" required hint="host 上的绝对路径,worktree 会在它的兄弟目录里创建">
            <div className="np__path">
              <input
                className="input np__path-input"
                placeholder={repoPathPlaceholder}
                value={repoPath}
                onChange={(e) => { setRepoPath(e.target.value); setPathDirty(true); }}
              />
              {onBrowseHost && (
                <button
                  className="btn btn-sm"
                  disabled={!defaultHostId}
                  onClick={() => setBrowseOpen(true)}
                >
                  {Icon.search} 浏览
                </button>
              )}
            </div>
            <label className="np__init">
              <input type="checkbox" checked={initRepo} onChange={(e) => setInitRepo(e.target.checked)} />
              <span>如果不是 git 仓库,自动执行 git init</span>
            </label>
          </Field>

          <div className="np__row">
            <Field label="合并策略">
              <select className="input" value={mergePolicy} onChange={(e) => setMergePolicy(e.target.value as MergePolicy)}>
                <option value="require-review">require-review · 等我点 Accept</option>
                <option value="auto-merge">auto-merge · 任务跑完自动合</option>
                <option value="auto-merge-if-tests-pass">auto-merge-if-tests-pass · 仅 tests 过才合</option>
              </select>
            </Field>

            <Field label="并发上限" hint="最多同时几个 runner">
              <div className="np__stepper">
                <button className="btn btn-sm btn-ghost" onClick={() => setConcurrencyLimit(Math.max(1, concurrencyLimit - 1))} disabled={concurrencyLimit <= 1}>−</button>
                <div className="np__stepper-value">{concurrencyLimit}</div>
                <button className="btn btn-sm btn-ghost" onClick={() => setConcurrencyLimit(Math.min(16, concurrencyLimit + 1))} disabled={concurrencyLimit >= 16}>+</button>
              </div>
            </Field>
          </div>

          <Field label="System prompt" hint="可选,会注入每个任务的对话开头">
            <textarea className="input np__textarea" placeholder="例:你是这个项目的高级开发,熟悉 TS。优先写测试。" rows={3} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
          </Field>
        </div>

        <footer className="modal__foot">
          <button className="btn btn-sm" onClick={onClose}>取消</button>
          <button
            className="btn btn-sm btn-primary"
            disabled={!canSubmit}
            onClick={() => onCreate?.({
              name, description,
              repoPath, defaultHostId, concurrencyLimit, systemPrompt,
              mergePolicy, initRepo,
            })}
          >
            {Icon.plus} 创建项目
          </button>
        </footer>

        {browseOpen && onBrowseHost && defaultHostId && (
          <FsBrowseModal
            hostId={defaultHostId}
            browse={onBrowseHost}
            onPick={(path) => { setRepoPath(path); setPathDirty(true); setBrowseOpen(false); }}
            onClose={() => setBrowseOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <div className="field__label">
        {label}
        {required && <span className="field__required">*</span>}
      </div>
      {children}
      {hint && <div className="field__hint">{hint}</div>}
    </div>
  );
}

/* ─── Inline host folder picker (web) ─────────────────────────────────────── */

function FsBrowseModal({
  hostId,
  browse,
  onPick,
  onClose,
}: {
  hostId: string;
  browse: (hostId: string, path?: string) => Promise<BrowseResponse>;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [cwd, setCwd] = useState<string>("");
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = (path?: string) => {
    setLoading(true);
    setError(null);
    browse(hostId, path)
      .then((res) => {
        setCwd(res.cwd);
        setEntries(res.entries.filter((e) => e.type === "dir"));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  // Load $HOME on first mount.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parent = cwd.replace(/\/[^/]+\/?$/, "") || "/";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal np-browse" onClick={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <div>
            <div className="modal__eyebrow">浏览 host</div>
            <h2 className="modal__title">{cwd || "正在读取目录"}</h2>
          </div>
          <button className="modal__close" onClick={onClose}>{Icon.x}</button>
        </header>
        <div className="modal__body np-browse__body">
          {error && <div className="np-browse__error">{error}</div>}
          {loading && (
            <div className="np-browse__loading" aria-busy="true">
              <LoadingState variant="inline" title="正在读取目录" subtitle={cwd || "连接 host 文件系统"} />
              <LoadingRows rows={4} compact />
            </div>
          )}
          {!loading && cwd && cwd !== "/" && (
            <button className="np-browse__row" onClick={() => load(parent)}>
              <span>{Icon.arrow}</span><span>..</span>
            </button>
          )}
          {!loading && entries.map((e) => (
            <button
              key={e.name}
              className="np-browse__row"
              onClick={() => load(joinPath(cwd, e.name))}
            >
              <span>{Icon.folder}</span>
              <span>{e.name}</span>
            </button>
          ))}
          {!loading && entries.length === 0 && <div className="np-browse__empty">这个目录里没有子目录</div>}
        </div>
        <footer className="modal__foot">
          <button className="btn btn-sm" onClick={onClose}>取消</button>
          <button
            className="btn btn-sm btn-primary"
            disabled={!cwd}
            onClick={() => onPick(cwd)}
          >
            选这个目录
          </button>
        </footer>
      </div>
    </div>
  );
}

function joinPath(base: string, leaf: string): string {
  if (!base) return leaf;
  if (base.endsWith("/")) return base + leaf;
  return base + "/" + leaf;
}
