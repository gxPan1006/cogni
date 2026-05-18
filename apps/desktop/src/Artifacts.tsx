/**
 * Artifacts — cross-domain library (SP-4 reference design).
 *
 * STATUS: presentational only. Shows everything the agent has produced across
 * threads and projects — patches, notes, screenshots, summaries. Filter by kind,
 * pin/unpin, click a card to open it (the detail view is not in this file; the
 * design canvas in the design system has a reference patch-viewer that the
 * SP-4 implementer can port using the same conventions as the rest of this
 * folder).
 */
import { useState } from "react";
import { Icon } from "./icons.js";
import "./artifacts.css";

type Kind = "patch" | "note" | "sql" | "screenshot" | "doc" | "shell";

const MOCK_ARTIFACTS: {
  id: string; kind: Kind; title: string; thread: string; when: string; size: string; pinned: boolean;
}[] = [
  { id: "a-001", kind: "patch",      title: "host-router multi-host extension", thread: "Refactor the dispatcher",   when: "12m ago", size: "4 files · +131 −62", pinned: true },
  { id: "a-002", kind: "note",       title: "SP-2 design summary",              thread: "Read SP-2 design doc",      when: "1h ago",  size: "2.4 KB",             pinned: true },
  { id: "a-003", kind: "sql",        title: "auth_sessions migration",          thread: "Schema for auth_sessions",  when: "3h ago",  size: "52 lines",           pinned: false },
  { id: "a-004", kind: "screenshot", title: "Spam folder screenshot",           thread: "Magic-link emails",         when: "yest.",   size: "1.1 MB · 2480×1640", pinned: false },
  { id: "a-005", kind: "patch",      title: "tauri deep-link wiring",           thread: "Deep-link callback",        when: "Mon",     size: "3 files · +44 −12",  pinned: false },
  { id: "a-006", kind: "note",       title: "Phone notes about Cogni naming",   thread: "—",                         when: "Mon",     size: "0.8 KB",             pinned: false },
  { id: "a-007", kind: "doc",        title: "How the dispatcher works",         thread: "Refactor the dispatcher",   when: "Sun",     size: "12 paragraphs",      pinned: false },
  { id: "a-008", kind: "shell",      title: "pnpm dev recipe for prod-cognit",  thread: "Deployment recipe",         when: "Sun",     size: "14 lines",           pinned: false },
];

const KIND_ICON: Record<Kind, React.ReactNode> = {
  patch: Icon.tool,
  note: Icon.file,
  sql: Icon.flow,
  screenshot: Icon.panel,
  doc: Icon.file,
  shell: Icon.bolt,
};
const KIND_LABEL: Record<Kind, string> = {
  patch: "Patch", note: "Note", sql: "SQL", screenshot: "Image", doc: "Doc", shell: "Shell",
};

export function Artifacts() {
  const [filter, setFilter] = useState<Kind | "all">("all");

  const tabs: { id: Kind | "all"; label: string; count: number }[] = [
    { id: "all",        label: "All",     count: MOCK_ARTIFACTS.length },
    { id: "patch",      label: "Patches", count: MOCK_ARTIFACTS.filter((a) => a.kind === "patch").length },
    { id: "note",       label: "Notes",   count: MOCK_ARTIFACTS.filter((a) => a.kind === "note").length },
    { id: "doc",        label: "Docs",    count: MOCK_ARTIFACTS.filter((a) => a.kind === "doc").length },
    { id: "shell",      label: "Shell",   count: MOCK_ARTIFACTS.filter((a) => a.kind === "shell").length },
    { id: "screenshot", label: "Images",  count: MOCK_ARTIFACTS.filter((a) => a.kind === "screenshot").length },
  ];
  const shown = filter === "all" ? MOCK_ARTIFACTS : MOCK_ARTIFACTS.filter((a) => a.kind === filter);
  const pinned = MOCK_ARTIFACTS.filter((a) => a.pinned);

  return (
    <div className="artifacts">
      <header className="artifacts__head">
        <div>
          <div className="artifacts__eyebrow">LIBRARY</div>
          <h1 className="artifacts__title">Artifacts</h1>
          <p className="artifacts__intro">
            Cogni 在所有对话和项目里生成的东西都汇到这里。值得保留的就 pin 起来。
          </p>
        </div>
        <div className="artifacts__search">
          <span className="artifacts__search-icon">{Icon.search}</span>
          <input className="artifacts__search-input" placeholder="搜索 artifacts" />
        </div>
      </header>

      <nav className="artifacts__tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={"artifacts__tab" + (filter === t.id ? " is-on" : "")}
            onClick={() => setFilter(t.id)}
          >
            {t.label} <span className="artifacts__tab-count">{t.count}</span>
          </button>
        ))}
      </nav>

      <div className="artifacts__body">
        {pinned.length > 0 && filter === "all" && (
          <section className="artifacts__section">
            <div className="artifacts__section-head">
              <span className="artifacts__section-icon">{Icon.spark}</span>
              <span className="artifacts__section-title">PINNED</span>
            </div>
            <div className="artifacts__grid">
              {pinned.map((a) => <Card key={a.id} a={a} />)}
            </div>
          </section>
        )}
        <section className="artifacts__section">
          <div className="artifacts__section-head">
            <span className="artifacts__section-title">EVERYTHING</span>
          </div>
          <div className="artifacts__grid">
            {shown.filter((a) => !a.pinned || filter !== "all").map((a) => <Card key={a.id} a={a} />)}
          </div>
        </section>
      </div>
    </div>
  );
}

function Card({ a }: { a: (typeof MOCK_ARTIFACTS)[number] }) {
  return (
    <button className="art-card" onClick={() => { /* open detail */ }}>
      <div className="art-card__thumb">
        <div className="art-card__thumb-fill">
          <span className="art-card__thumb-icon">{KIND_ICON[a.kind]}</span>
        </div>
        <span className="art-card__kind">{KIND_LABEL[a.kind]}</span>
      </div>
      <div className="art-card__body">
        <div className="art-card__title">{a.title}</div>
        <div className="art-card__thread">{a.thread}</div>
        <div className="art-card__foot">
          <span className="art-card__time">{a.when}</span>
          <span className="art-card__size">{a.size}</span>
        </div>
      </div>
    </button>
  );
}
