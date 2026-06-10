/**
 * ProjectFiles — the project's "Files" view (a board tab alongside
 * Columns / Swarm / Timeline). A VS Code–shaped browser of the project repo:
 * a lazy-loaded tree on the left, a tabbed code viewer on the right.
 *
 * Files belong to the PROJECT, not a task — this replaces the old per-task
 * "文件" tab in TaskDetail. The tree and file content are REAL: the tree
 * lazy-loads one directory at a time via `api.browseProjectDir` (same
 * endpoint ArtifactBrowser uses), and a clicked file's bytes come from
 * `api.fetchProjectFile`.
 *
 * The AI-activity layer from the design handoff (per-file live/modified/
 * review/new/failed annotations + the right-hand activity rail + the in-file
 * "an agent is editing these lines" overlay) needs backend that doesn't exist
 * yet. Its mount points are kept — `AnnotChip`, `Legend`, `FileActivityRail`,
 * the live read-only chip — but they render nothing until an `annotations`
 * map / events get wired. Default layout is `split` so we never show an empty
 * rail; pass `layout="triple"` once activity data exists.
 */
import { useCallback, useEffect, useState, Fragment } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient } from "../../transport/api.js";
import type { FsBrowseEntry } from "@cogni/contract";
import { Icon } from "../icons.js";
import "./project-files.css";

type Layout = "split" | "triple" | "compact";

// Per-file AI annotation (design handoff). No backend yet → `annotations` is
// empty, so AnnotChip / the rail state block render nothing. Kept so wiring is
// a one-prop change later (drive from the project event stream).
type FileAnnotState = "live" | "modified" | "review" | "new" | "failed";
interface FileAnnot { state: FileAnnotState; taskRef: string; lines?: string }
interface FileEvent { t: string; who: string; what: string; tone: "live" | "tool" | "review" | "you" | "past" }

interface ViewerContent {
  kind: "text" | "image" | "binary";
  lines?: string[];
  blobUrl?: string;
  error?: string;
}

const TEXT_EXT = new Set([
  "txt", "md", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rs", "go",
  "java", "c", "h", "cpp", "json", "yaml", "yml", "sh", "toml", "xml", "csv",
  "sql", "html", "htm", "env", "gitignore", "lock",
]);
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"]);

function kindFor(name: string): ViewerContent["kind"] {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (IMG_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}

// File-icon glyph + accent per extension. Keyed by raw ext string so we don't
// need an exhaustive enum; unknown extensions fall back to a neutral dot.
const FILE_PALETTE: Record<string, [string, string]> = {
  ts: ["TS", "oklch(60% 0.12 240)"], tsx: ["TS", "oklch(60% 0.12 240)"],
  js: ["JS", "oklch(72% 0.13 90)"], mjs: ["JS", "oklch(72% 0.13 90)"],
  cjs: ["JS", "oklch(72% 0.13 90)"], jsx: ["JS", "oklch(72% 0.13 90)"],
  rs: ["RS", "oklch(58% 0.13 30)"], sql: ["SQ", "oklch(60% 0.12 175)"],
  json: ["{}", "oklch(60% 0.04 80)"], yaml: ["Y", "oklch(60% 0.04 80)"],
  yml: ["Y", "oklch(60% 0.04 80)"], toml: ["T", "oklch(60% 0.04 80)"],
  md: ["M", "oklch(55% 0.04 60)"], css: ["C", "oklch(62% 0.13 320)"],
  html: ["<>", "oklch(62% 0.13 30)"],
  png: ["IM", "oklch(64% 0.10 150)"], jpg: ["IM", "oklch(64% 0.10 150)"],
  jpeg: ["IM", "oklch(64% 0.10 150)"], svg: ["IM", "oklch(64% 0.10 150)"],
};
function paletteFor(name: string): [string, string] {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return FILE_PALETTE[ext] ?? ["·", "oklch(60% 0.01 60)"];
}

const baseName = (path: string) => path.split("/").pop() ?? path;

export function ProjectFiles({
  api,
  projectId,
  layout = "split",
  annotations = {},
}: {
  api: ApiClient;
  projectId: string;
  layout?: Layout;
  /** path → AI annotation. Empty until the activity backend is wired. */
  annotations?: Record<string, FileAnnot>;
}) {
  const { t } = useTranslation();
  const [root, setRoot] = useState<string>("");                          // absolute repo root
  const [children, setChildren] = useState<Record<string, FsBrowseEntry[]>>({}); // absPath → entries
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<{ path: string; name: string }[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [content, setContent] = useState<Record<string, ViewerContent>>({});
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Revoke any image object URLs on unmount.
  useEffect(() => () => {
    for (const c of Object.values(content)) if (c.blobUrl) URL.revokeObjectURL(c.blobUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDir = useCallback(async (path?: string) => {
    try {
      const res = await api.browseProjectDir(projectId, path);
      setChildren((c) => ({ ...c, [path ?? res.cwd]: res.entries }));
      if (!path) setRoot(res.cwd);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, projectId]);

  useEffect(() => { void loadDir(undefined); }, [loadDir]);

  const toggleDir = (path: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
    if (!children[path]) void loadDir(path);
  };

  const openFile = useCallback(async (path: string, name: string) => {
    setActive(path);
    setTabs((prev) => (prev.some((tb) => tb.path === path) ? prev : [...prev, { path, name }]));
    if (content[path]) return;
    const kind = kindFor(name);
    try {
      const blob = await api.fetchProjectFile(projectId, path);
      if (kind === "text") {
        const text = await blob.text();
        setContent((c) => ({ ...c, [path]: { kind, lines: text.replace(/\n$/, "").split("\n") } }));
      } else if (kind === "image") {
        setContent((c) => ({ ...c, [path]: { kind, blobUrl: URL.createObjectURL(blob) } }));
      } else {
        setContent((c) => ({ ...c, [path]: { kind } }));
      }
    } catch (e) {
      setContent((c) => ({ ...c, [path]: { kind: "binary", error: e instanceof Error ? e.message : String(e) } }));
    }
  }, [api, projectId, content]);

  const closeTab = (path: string) => {
    const remaining = tabs.filter((tb) => tb.path !== path);
    setTabs(remaining);
    if (active === path) setActive(remaining.length ? remaining[remaining.length - 1]!.path : null);
  };

  const download = useCallback((path: string, name: string) => {
    void (async () => {
      try {
        const blob = await api.fetchProjectFile(projectId, path);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [api, projectId]);

  const refresh = () => { setChildren({}); setContent({}); setOpen(new Set()); void loadDir(undefined); };

  const topLevel = root ? children[root] ?? [] : [];
  const showLegend = Object.keys(annotations).length > 0;
  const activeContent = active ? content[active] : undefined;

  return (
    <div className={`pf pf--${layout}`}>
      <FilesStatusBar root={root} onRefresh={refresh} t={t} />
      <div className="pf__body">
        <aside className="pf__tree">
          <div className="pf__search">
            <span className="pf__search-icon">{Icon.search}</span>
            <input
              className="pf__search-input"
              placeholder={t("project.files.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="pf__tree-head">
            <span className="pf__tree-title">{baseName(root) || t("project.files.treeRoot")}</span>
            <div style={{ flex: 1 }} />
            <button className="pf__iconbtn" title={t("project.files.collapseAll")} onClick={() => setOpen(new Set())}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 12h16" /></svg>
            </button>
            <button className="pf__iconbtn" title={t("project.files.refresh")} onClick={refresh}>{Icon.refresh}</button>
          </div>
          <div className="pf__tree-body">
            {error && <div className="pf__tree-error">{error}</div>}
            {!error && topLevel.length === 0 && (
              <div className="pf__tree-empty">{root ? t("project.files.emptyTree") : t("project.files.loading")}</div>
            )}
            {topLevel.map((entry) => (
              <TreeNode
                key={entry.name}
                entry={entry}
                parentPath={root}
                depth={0}
                openSet={open}
                childrenMap={children}
                annotations={annotations}
                activePath={active}
                query={query.trim().toLowerCase()}
                onToggle={toggleDir}
                onOpen={openFile}
              />
            ))}
          </div>
          {showLegend && <Legend t={t} />}
        </aside>

        {layout !== "compact" && (
          <section className="pf__viewer">
            <Tabs
              tabs={tabs}
              active={active}
              annotations={annotations}
              onSelect={setActive}
              onClose={closeTab}
            />
            {active
              ? <FileView path={active} content={activeContent} annot={annotations[active]} onDownload={download} t={t} />
              : <FileEmpty t={t} />}
          </section>
        )}

        {layout === "triple" && active && (
          <aside className="pf__rail">
            <FileActivityRail path={active} events={[]} annot={annotations[active]} onSendToChat={() => {}} t={t} />
          </aside>
        )}
      </div>
    </div>
  );
}

/* ─── Tree ──────────────────────────────────────────── */

function TreeNode({
  entry, parentPath, depth, openSet, childrenMap, annotations, activePath, query, onToggle, onOpen,
}: {
  entry: FsBrowseEntry;
  parentPath: string;
  depth: number;
  openSet: Set<string>;
  childrenMap: Record<string, FsBrowseEntry[]>;
  annotations: Record<string, FileAnnot>;
  activePath: string | null;
  query: string;
  onToggle: (path: string) => void;
  onOpen: (path: string, name: string) => void;
}) {
  const here = parentPath ? `${parentPath}/${entry.name}` : entry.name;

  if (entry.type === "dir") {
    const isOpen = openSet.has(here);
    const kids = childrenMap[here] ?? [];
    return (
      <>
        <button
          className={`pf-ft__row pf-ft__row--dir ${isOpen ? "is-open" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => onToggle(here)}
        >
          <span className="pf-ft__chev">{isOpen ? "▾" : "▸"}</span>
          <span className="pf-ft__name">{entry.name}</span>
        </button>
        {isOpen && kids.map((c) => (
          <TreeNode
            key={c.name}
            entry={c}
            parentPath={here}
            depth={depth + 1}
            openSet={openSet}
            childrenMap={childrenMap}
            annotations={annotations}
            activePath={activePath}
            query={query}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        ))}
      </>
    );
  }

  // File row — hidden when a search query doesn't match its name.
  if (query && !entry.name.toLowerCase().includes(query)) return null;
  const [glyph, color] = paletteFor(entry.name);
  return (
    <button
      className={`pf-ft__row pf-ft__row--file ${activePath === here ? "is-active" : ""} ${annotations[here]?.state === "live" ? "has-live" : ""}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => onOpen(here, entry.name)}
    >
      <span className="pf-ft__chev" style={{ visibility: "hidden" }}>·</span>
      <span className="pf-ft__icon" style={{ color }}>{glyph}</span>
      <span className="pf-ft__name">{entry.name}</span>
      <span style={{ flex: 1 }} />
      <AnnotChip annot={annotations[here]} />
    </button>
  );
}

function AnnotChip({ annot }: { annot?: FileAnnot }) {
  if (!annot) return null;
  if (annot.state === "live") {
    return (
      <span className="pf-ft__annot pf-ft__annot--live" title={`${annot.taskRef} editing live`}>
        <span className="pf-ft__annot-dot" /> {annot.taskRef}
      </span>
    );
  }
  if (annot.state === "modified") return <span className="pf-ft__annot pf-ft__annot--mod" title="modified">M</span>;
  if (annot.state === "review")   return <span className="pf-ft__annot pf-ft__annot--rev" title="awaiting review">◔</span>;
  if (annot.state === "new")      return <span className="pf-ft__annot pf-ft__annot--new" title="created by a task">+</span>;
  if (annot.state === "failed")   return <span className="pf-ft__annot pf-ft__annot--fail" title="task failed">!</span>;
  return null;
}

/* ─── Status bar ────────────────────────────────────── */

function FilesStatusBar({ root, onRefresh, t }: { root: string; onRefresh: () => void; t: TFn }) {
  return (
    <div className="pf__statusbar">
      <div className="pf__statusbar-l">
        <span className="pf__crumb" title={root}>{root || "…"}</span>
      </div>
      <div className="pf__statusbar-r">
        <button className="pf__iconbtn" title={t("project.files.refresh")} onClick={onRefresh}>{Icon.refresh}</button>
      </div>
    </div>
  );
}

/* ─── Tabs ──────────────────────────────────────────── */

function Tabs({ tabs, active, annotations, onSelect, onClose }: {
  tabs: { path: string; name: string }[];
  active: string | null;
  annotations: Record<string, FileAnnot>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  if (tabs.length === 0) return <div className="pf__tabs pf__tabs--empty" />;
  return (
    <div className="pf__tabs">
      {tabs.map(({ path, name }) => {
        const [glyph, color] = paletteFor(name);
        const annot = annotations[path];
        return (
          <button
            key={path}
            className={`pf__tab ${active === path ? "is-active" : ""}`}
            onClick={() => onSelect(path)}
          >
            <span className="pf-ft__icon" style={{ color }}>{glyph}</span>
            <span className="pf__tab-name">{name}</span>
            {annot?.state === "live" && (
              <span className="pf__tab-live" title={`${annot.taskRef} editing`}>
                <span className="pf__tab-live-dot" />
                {annot.taskRef}
              </span>
            )}
            <span className="pf__tab-close" onClick={(e) => { e.stopPropagation(); onClose(path); }}>×</span>
          </button>
        );
      })}
    </div>
  );
}

/* ─── Viewer ────────────────────────────────────────── */

function FileView({ path, content, annot, onDownload, t }: {
  path: string;
  content?: ViewerContent;
  annot?: FileAnnot;
  onDownload: (path: string, name: string) => void;
  t: TFn;
}) {
  const segs = path.split("/").filter(Boolean);
  return (
    <div className="pf__view">
      <div className="pf__view-head">
        <div className="pf__view-crumb">
          {segs.slice(-4).map((seg, i, arr) => (
            <Fragment key={i}>
              {i > 0 && <span className="pf__view-crumb-sep">/</span>}
              <span className={i === arr.length - 1 ? "pf__view-crumb-leaf" : ""}>{seg}</span>
            </Fragment>
          ))}
        </div>
        <div className="pf__view-head-r">
          {annot?.state === "live" && (
            <span className="pf__readonly" title={t("project.files.readonlyHint")}>
              <span className="pf__readonly-dot" /> {t("project.files.readonly")}
            </span>
          )}
          <button className="pf__iconbtn" title={t("project.files.download")} onClick={() => onDownload(path, baseName(path))}>{Icon.attach}</button>
        </div>
      </div>

      {!content && <div className="pf__view-loading">{t("project.files.loading")}</div>}

      {content?.kind === "text" && content.lines && (
        <div className="pf__code">
          {content.lines.map((line, i) => (
            <div key={i} className="pf__line">
              <span className="pf__line-num">{i + 1}</span>
              <span className="pf__line-txt">{line || <span>&nbsp;</span>}</span>
            </div>
          ))}
        </div>
      )}

      {content?.kind === "image" && content.blobUrl && (
        <div className="pf__image"><img src={content.blobUrl} alt={baseName(path)} /></div>
      )}

      {content?.kind === "binary" && (
        <div className="pf__empty">
          <div className="pf__empty-label">{t("project.files.noPreview")}</div>
          <div className="pf__empty-body">
            <button className="pf__dl-btn" onClick={() => onDownload(path, baseName(path))}>{t("project.files.download")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function FileEmpty({ t }: { t: TFn }) {
  return (
    <div className="pf__empty">
      <div className="pf__empty-label">{t("project.files.noPreview")}</div>
      <div className="pf__empty-body">{t("project.files.selectFile")}</div>
    </div>
  );
}

/* ─── Activity rail (mount point — empty until backend) ─ */

function FileActivityRail({ path, events, annot, onSendToChat, t }: {
  path: string;
  events: FileEvent[];
  annot?: FileAnnot;
  onSendToChat: () => void;
  t: TFn;
}) {
  return (
    <div className="pf__act">
      <div className="pf__act-head">
        <span className="pf__act-title">{t("project.files.activity")}</span>
        <span style={{ flex: 1 }} />
        <span className="pf__act-count">{events.length}</span>
      </div>
      <div className="pf__act-sub">{baseName(path)}</div>

      {annot && annot.state === "live" && (
        <div className="pf__act-stateblock">
          <div className="pf__act-stateblock-label">STATE</div>
          <div className="pf__act-state-row">
            <span className="pf__act-livedot" />
            <span>{annot.taskRef}</span>
          </div>
        </div>
      )}

      <div className="pf__act-events">
        {events.map((e, i) => (
          <div key={i} className={`pf__act-ev pf__act-ev--${e.tone}`}>
            <span className="pf__act-ev-t">{e.t}</span>
            <span className="pf__act-ev-tag">{e.who}</span>
            <span className="pf__act-ev-what">{e.what}</span>
          </div>
        ))}
        {events.length === 0 && <div className="pf__act-empty">{t("project.files.noActivity")}</div>}
      </div>

      <div className="pf__act-actions">
        <button className="pf__act-action" onClick={onSendToChat}>{Icon.attach} {t("project.files.sendToChat")}</button>
      </div>
    </div>
  );
}

/* ─── Legend (shown only when annotations exist) ─────── */

function Legend({ t }: { t: TFn }) {
  return (
    <div className="pf__legend">
      <div className="pf__legend-head">{t("project.files.legendHead")}</div>
      <div className="pf__legend-row"><span className="pf__legend-dot pf__legend-dot--live" /> {t("project.files.legendLive")}</div>
      <div className="pf__legend-row"><span className="pf__legend-tag pf__legend-tag--mod">M</span> {t("project.files.legendModified")}</div>
      <div className="pf__legend-row"><span className="pf__legend-tag pf__legend-tag--rev">◔</span> {t("project.files.legendReview")}</div>
      <div className="pf__legend-row"><span className="pf__legend-tag pf__legend-tag--new">+</span> {t("project.files.legendNew")}</div>
      <div className="pf__legend-row"><span className="pf__legend-tag pf__legend-tag--fail">!</span> {t("project.files.legendFailed")}</div>
    </div>
  );
}

// Minimal translate-fn type so the leaf components don't each import i18next.
type TFn = (key: string, opts?: Record<string, unknown>) => string;
