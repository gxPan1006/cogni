/**
 * HostFallbackCard — inline prompt rendered above the composer when the
 * thread's preferred host is offline but other devices are online.
 *
 * User flow:
 *   1. User sends a message; cloud notices preferred host is offline.
 *   2. Cloud sends a `host-fallback-prompt` over WS — useThreadStream stores
 *      it as `pendingFallback` and renders this card.
 *   3. User picks an alternative host (radio) and clicks "切换并发送", which
 *      calls onSwitch(targetHostId) → useThreadStream sends `resolve-fallback`.
 *      Or clicks "取消" to cancel — calls onCancel → resolve-fallback{cancel}.
 *   4. The composer stays disabled while the card is up so the user can't
 *      pile on more text before resolving.
 */
import { useState } from "react";

type HostRef = { id: string; name: string; lastSeenAgoMs: number };

export function HostFallbackCard({
  preferred,
  alternatives,
  onSwitch,
  onCancel,
}: {
  preferred: HostRef;
  alternatives: HostRef[];
  onSwitch: (targetHostId: string) => void;
  onCancel: () => void;
}) {
  const [chosen, setChosen] = useState<string | null>(alternatives[0]?.id ?? null);
  return (
    <div className="fallback-card">
      <div className="fallback-card__title">
        ⚠️ &nbsp;<strong>{preferred.name}</strong> 不在线 (last seen {fmtAgo(preferred.lastSeenAgoMs)})
      </div>
      <div className="fallback-card__body">
        <div>切到这台机器跑?</div>
        <ul className="fallback-card__options">
          {alternatives.map((a) => (
            <li key={a.id}>
              <label>
                <input
                  type="radio"
                  name="fallback-target"
                  checked={chosen === a.id}
                  onChange={() => setChosen(a.id)}
                />
                {a.name} <span className="fallback-card__sub">(online · {fmtAgo(a.lastSeenAgoMs)})</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="fallback-card__note">
          Claude Code 会在新机器上从消息历史重建上下文,之前在 {preferred.name} 上未保存的文件不会过来。
        </div>
      </div>
      <div className="fallback-card__actions">
        <button
          className="fallback-card__primary"
          disabled={!chosen}
          onClick={() => chosen && onSwitch(chosen)}
        >
          切换并发送
        </button>
        <button className="fallback-card__secondary" onClick={onCancel}>
          取消(等 {preferred.name} 上线)
        </button>
      </div>
    </div>
  );
}

function fmtAgo(ms: number) {
  if (ms < 60_000) return "刚刚";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
