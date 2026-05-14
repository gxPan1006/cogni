import type { ThreadSummary } from "@cogni/contract";

export function Sidebar(props: {
  mode: "chat" | "project";
  onMode: (m: "chat" | "project") => void;
  threads: ThreadSummary[];
  activeThreadId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
}) {
  return (
    <div style={{ width: 240, borderRight: "1px solid #ddd", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", padding: 8, gap: 4 }}>
        <button disabled={props.mode === "chat"} onClick={() => props.onMode("chat")}>chat</button>
        {/* 项目 mode is disabled in SP-1 — it ships in SP-3 */}
        <button disabled title="SP-3">项目</button>
      </div>
      <button onClick={props.onNewChat} style={{ margin: 8 }}>+ New chat</button>
      <div style={{ overflowY: "auto", flex: 1 }}>
        <div style={{ padding: "4px 8px", color: "#888", fontSize: 12 }}>Recents</div>
        {props.threads.map((t) => (
          <div
            key={t.id}
            onClick={() => props.onSelect(t.id)}
            style={{
              padding: "6px 8px",
              cursor: "pointer",
              background: t.id === props.activeThreadId ? "#eee" : "transparent",
            }}
          >
            {t.title}
          </div>
        ))}
      </div>
    </div>
  );
}
