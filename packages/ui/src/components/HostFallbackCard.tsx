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
import { Trans, useTranslation } from "react-i18next";
import { i18n } from "../i18n/index.js";

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
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<string | null>(alternatives[0]?.id ?? null);
  return (
    <div className="fallback-card">
      <div className="fallback-card__title">
        ⚠️ &nbsp;
        <Trans
          i18nKey="chat.hostFallback.offlineTitle"
          values={{ ago: fmtAgo(preferred.lastSeenAgoMs) }}
          components={[<strong key="name">{preferred.name}</strong>]}
        />
      </div>
      <div className="fallback-card__body">
        <div>{t("chat.hostFallback.switchHere")}</div>
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
                {a.name} <span className="fallback-card__sub">{t("chat.hostFallback.onlineSub", { ago: fmtAgo(a.lastSeenAgoMs) })}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="fallback-card__note">
          {t("chat.hostFallback.rebuildNote", { host: preferred.name })}
        </div>
      </div>
      <div className="fallback-card__actions">
        <button
          className="fallback-card__primary"
          disabled={!chosen}
          onClick={() => chosen && onSwitch(chosen)}
        >
          {t("chat.hostFallback.switchAndSend")}
        </button>
        <button className="fallback-card__secondary" onClick={onCancel}>
          {t("chat.hostFallback.cancelWait", { host: preferred.name })}
        </button>
      </div>
    </div>
  );
}

function fmtAgo(ms: number) {
  if (ms < 60_000) return i18n.t("chat.hostFallback.agoJustNow");
  if (ms < 3_600_000) return i18n.t("chat.hostFallback.agoMin", { n: Math.floor(ms / 60_000) });
  if (ms < 86_400_000) return i18n.t("chat.hostFallback.agoHour", { n: Math.floor(ms / 3_600_000) });
  return i18n.t("chat.hostFallback.agoDay", { n: Math.floor(ms / 86_400_000) });
}
