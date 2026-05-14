import { useState } from "react";
import type { RunnerEvent } from "@cogni/contract";
import { useThreadStream } from "./useThreadStream.js";

function EventBlock({ event }: { event: RunnerEvent }) {
  if (event.type === "text") return <span>{event.text}</span>;
  if (event.type === "tool-call")
    return <pre style={{ background: "#f4f4f4" }}>🔧 {event.name}({JSON.stringify(event.input)})</pre>;
  if (event.type === "tool-result")
    return <pre style={{ background: "#f0f7f0" }}>↳ {String(event.output).slice(0, 200)}</pre>;
  if (event.type === "error")
    return <pre style={{ color: "crimson" }}>⚠ {event.code}: {event.message}</pre>;
  return null;
}

export function Conversation({
  token,
  threadId,
}: {
  token: string;
  threadId: string;
  onTitleMaybeChanged?: () => void;
}) {
  const { messages, streaming, hostOnline, connected, send } = useThreadStream(token, threadId);
  const [draft, setDraft] = useState("");

  const submit = () => {
    if (!draft.trim()) return;
    if (send(draft)) setDraft("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {!connected && (
        <div style={{ background: "#f8d7da", padding: 8, fontSize: 13 }}>
          与服务器的连接已断开,正在重连…
        </div>
      )}
      {connected && !hostOnline && (
        <div style={{ background: "#fff3cd", padding: 8, fontSize: 13 }}>
          本地运行环境未连接 —— 启动你电脑上的 Cogni 才能跑任务
        </div>
      )}
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {messages.map((m) => (
          <div key={m.id} style={{ margin: "8px 0" }}>
            <b>{m.role === "user" ? "你" : m.role === "assistant" ? "Cogni" : "系统"}:</b> {m.content}
          </div>
        ))}
        {streaming.length > 0 && (
          <div style={{ margin: "8px 0", color: "#444" }}>
            <b>Cogni:</b> {streaming.map((e, i) => <EventBlock key={i} event={e} />)}
          </div>
        )}
      </div>
      <div style={{ display: "flex", padding: 8, borderTop: "1px solid #ddd" }}>
        <input
          style={{ flex: 1 }}
          value={draft}
          placeholder="Write a message..."
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button onClick={submit}>发送</button>
      </div>
    </div>
  );
}
