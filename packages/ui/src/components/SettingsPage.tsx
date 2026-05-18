/**
 * SettingsPage — Account / Sign-in / Devices / Runner Hosts / Customize / About.
 *
 * SP-2: Account / Devices / Hosts are wired to the cloud via the three
 * settings hooks (useIdentities / useDevices / useHosts). Customize stays
 * local-only state. About is static text.
 *
 * `user` prop carries the display name + email until /api/me lands; pass it
 * down from whatever decoded the JWT (Shell.tsx on desktop, WebShell on web).
 */
import { useState } from "react";
import { Icon } from "./icons.js";
import type { ApiClient } from "../transport/api.js";
import { useIdentities } from "../hooks/useIdentities.js";
import { useDevices } from "../hooks/useDevices.js";
import { useHosts } from "../hooks/useHosts.js";
import "./settings.css";

type Page = "account" | "devices" | "hosts" | "customize" | "about";

export function SettingsPage({
  api,
  user = { name: "you", email: "—" },
  onClose,
}: {
  api: ApiClient;
  user?: { name: string; email: string };
  onClose?: () => void;
}) {
  const [page, setPage] = useState<Page>("account");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [accentHue, setAccentHue] = useState<number>(50);

  return (
    <div className="settings">
      <div className="settings__nav">
        <div className="settings__title">
          {onClose && (
            <button className="btn btn-sm btn-ghost" onClick={onClose} title="关闭设置">
              {Icon.x}
            </button>
          )}
          <div className="settings__title-text">设置</div>
        </div>
        <nav className="settings__menu">
          {(
            [
              ["account",   "账户",       Icon.user],
              ["devices",   "设备",       Icon.desktop],
              ["hosts",     "Runner Hosts", Icon.flow],
              ["customize", "外观",       Icon.spark],
              ["about",     "关于",       Icon.shield],
            ] as const
          ).map(([id, label, icon]) => (
            <button
              key={id}
              className={"settings__menu-item" + (page === id ? " is-on" : "")}
              onClick={() => setPage(id)}
            >
              <span className="settings__menu-icon">{icon}</span>
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </div>

      <div className="settings__body">
        {page === "account"   && <AccountPage api={api} user={user} />}
        {page === "devices"   && <DevicesPage api={api} />}
        {page === "hosts"     && <HostsPage api={api} />}
        {page === "customize" && <CustomizePage theme={theme} onTheme={setTheme} accentHue={accentHue} onAccentHue={setAccentHue} />}
        {page === "about"     && <AboutPage />}
      </div>
    </div>
  );
}

/* ─── Account ──────────────────────────────────────────── */

function AccountPage({
  api, user,
}: {
  api: ApiClient;
  user: { name: string; email: string };
}) {
  const initial = user.name.slice(0, 1).toUpperCase();
  const { identities, loading, remove } = useIdentities(api);
  // Guard against locking yourself out — disable the last Disconnect button.
  const canRemove = identities.length > 1;

  return (
    <>
      <SectionHead title="账户" subtitle="一个身份,跨 Google、邮件链接、任何登录过的设备。" />
      <div className="settings-card">
        <Row
          icon={<span className="settings-bigchar">{initial}</span>}
          title={user.name}
          sub={`${user.email} · default tenant`}
          right={<button className="btn btn-sm btn-ghost" disabled title="改名 API 还没接">改名</button>}
        />
      </div>

      <SectionHead title="登录方式" subtitle="至少保留一种,否则下次进不来。" />
      <div className="settings-card">
        {loading && <div className="settings-card__foot"><span>加载中…</span></div>}
        {!loading && identities.length === 0 && (
          <div className="settings-card__foot"><span>没有任何登录方式 — 这不该发生</span></div>
        )}
        {!loading && identities.map((id) => (
          <Row
            key={`${id.kind}-${id.sub}`}
            icon={<span style={{ fontSize: 14 }}>{kindIcon(id.kind)}</span>}
            title={kindLabel(id.kind)}
            sub={id.sub}
            right={
              <button
                className="btn btn-sm"
                disabled={!canRemove}
                title={canRemove ? "解绑这个登录方式" : "至少保留一种登录方式"}
                onClick={() => { void remove(id.kind, id.sub); }}
              >
                解绑
              </button>
            }
          />
        ))}
        <div className="settings-card__foot">
          <span style={{ color: "var(--warn)" }}>{Icon.shield}</span>
          <span>至少保留一种登录方式。</span>
        </div>
      </div>
    </>
  );
}

function kindLabel(kind: string): string {
  if (kind === "google") return "Google";
  if (kind === "email") return "邮件登录链接";
  if (kind === "dev") return "Dev token";
  return kind;
}
function kindIcon(kind: string): string {
  if (kind === "google") return "G";
  if (kind === "email") return "✉";
  if (kind === "dev") return "🔧";
  return "?";
}

/* ─── Devices ──────────────────────────────────────────── */

function DevicesPage({ api }: { api: ApiClient }) {
  const { devices, loading, revoke } = useDevices(api);
  const revokeOthers = async () => {
    for (const d of devices) if (!d.isCurrent) await revoke(d.id);
  };
  const hasOthers = devices.some((d) => !d.isCurrent);

  return (
    <>
      <SectionHead
        title="已登录的设备"
        subtitle="当前能拿你账号说话的会话。撤销后那台设备立即被踢出。"
        action={
          <button className="btn btn-sm" disabled={!hasOthers} onClick={() => { void revokeOthers(); }}>
            撤销其它所有
          </button>
        }
      />
      <div className="settings-card">
        {loading && <div className="settings-card__foot"><span>加载中…</span></div>}
        {!loading && devices.length === 0 && (
          <div className="settings-card__foot"><span>没有任何已登录设备</span></div>
        )}
        {!loading && devices.map((d) => (
          <Row
            key={d.id}
            current={d.isCurrent}
            icon={deviceKindIcon(d.deviceName)}
            title={d.deviceName}
            sub={`${fmtRelative(d.lastSeenAt)}${d.ip ? " · IP " + d.ip : ""}`}
            right={
              d.isCurrent
                ? <span className="settings-card__current-tag">当前设备</span>
                : <button className="btn btn-sm" onClick={() => { void revoke(d.id); }}>撤销</button>
            }
          />
        ))}
      </div>
    </>
  );
}

function deviceKindIcon(deviceName: string) {
  const n = deviceName.toLowerCase();
  if (n.includes("iphone") || n.includes("ipad") || n.includes("android")) return Icon.phone;
  if (n.includes("chrome") || n.includes("safari") || n.includes("firefox") || n.includes("edge") || n.includes("browser")) return Icon.globe;
  return Icon.desktop;
}

function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/* ─── Hosts ────────────────────────────────────────────── */

function HostsPage({ api }: { api: ApiClient }) {
  const { hosts, loading, rename, remove } = useHosts(api);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  return (
    <>
      <SectionHead
        title="Runner Hosts"
        subtitle="能跑 agent 的机器。每台机器汇报自己装了什么 adapter。"
      />
      <div className="settings-card">
        {loading && <div className="settings-card__foot"><span>加载中…</span></div>}
        {!loading && hosts.length === 0 && (
          <div className="settings-card__foot"><span>还没有 Runner Host — 在 Mac 上打开 cogni 桌面端就会自动注册</span></div>
        )}
        {!loading && hosts.map((h) => {
          const isEditing = editingId === h.id;
          return (
            <Row
              key={h.id}
              icon={<span className={"dot " + (h.status === "online" ? "dot-online" : "dot-offline")} style={{ width: 8, height: 8 }} />}
              title={
                isEditing ? (
                  <input
                    className="settings-card__rename-input"
                    value={draftName}
                    autoFocus
                    onChange={(e) => setDraftName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && draftName.trim()) {
                        void rename(h.id, draftName.trim()).finally(() => setEditingId(null));
                      } else if (e.key === "Escape") {
                        setEditingId(null);
                      }
                    }}
                  />
                ) : h.name
              }
              sub={`${h.status}${h.lastSeen ? " · 最后在线 " + fmtRelative(h.lastSeen) : ""}`}
              right={
                <div className="settings-card__row-actions">
                  {isEditing ? (
                    <>
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          if (draftName.trim()) {
                            void rename(h.id, draftName.trim()).finally(() => setEditingId(null));
                          }
                        }}
                      >✓</button>
                      <button className="btn btn-sm btn-ghost" onClick={() => setEditingId(null)}>×</button>
                    </>
                  ) : (
                    <>
                      <button
                        className="btn btn-sm btn-ghost"
                        title="改名"
                        onClick={() => { setEditingId(h.id); setDraftName(h.name); }}
                      >{Icon.edit}</button>
                      <button
                        className="btn btn-sm btn-ghost"
                        style={{ color: "var(--bad)" }}
                        title="移除"
                        onClick={() => { void remove(h.id); }}
                      >{Icon.trash}</button>
                    </>
                  )}
                </div>
              }
            />
          );
        })}
        <div className="settings-card__foot">
          <span style={{ color: "var(--muted)" }}>+</span>
          <span>要加新机器:在那台机器装 Cogni 桌面 app 并登录。</span>
        </div>
      </div>
    </>
  );
}

/* ─── Customize ───────────────────────────────────────── */

function CustomizePage({
  theme, onTheme, accentHue, onAccentHue,
}: {
  theme: "light" | "dark";
  onTheme: (v: "light" | "dark") => void;
  accentHue: number;
  onAccentHue: (h: number) => void;
}) {
  const accents = [
    { id: 50,  name: "Clay" },
    { id: 158, name: "Sage" },
    { id: 270, name: "Indigo" },
    { id: 28,  name: "Ember" },
  ];
  return (
    <>
      <SectionHead title="外观" subtitle="应用的视觉调性。会跨设备同步。" />

      <div className="settings-card">
        <Row
          icon={theme === "dark" ? Icon.moon : Icon.sun}
          title="主题"
          sub={theme === "dark" ? "深色 · 适合低光环境" : "浅色 · 适合白天"}
          right={
            <div className="seg">
              <button className={"seg__btn" + (theme === "light" ? " is-on" : "")} onClick={() => onTheme("light")}>浅</button>
              <button className={"seg__btn" + (theme === "dark"  ? " is-on" : "")} onClick={() => onTheme("dark")}>深</button>
              <button className="seg__btn">跟随系统</button>
            </div>
          }
        />
        <Row
          icon={Icon.spark}
          title="主色"
          sub="用于激活态、发送按钮、host 在线 halo。"
          right={
            <div className="settings-card__swatches">
              {accents.map((a) => (
                <button
                  key={a.id}
                  className={"settings-card__swatch" + (accentHue === a.id ? " is-on" : "")}
                  onClick={() => onAccentHue(a.id)}
                  style={{ background: `oklch(60% 0.135 ${a.id})` }}
                  title={a.name}
                />
              ))}
            </div>
          }
        />
      </div>

      <SectionHead title="快捷键" subtitle="无论怎么调都不变。" />
      <div className="settings-card">
        {[
          ["新对话",              "⌘ N"],
          ["搜索",                "⌘ K"],
          ["折叠侧边栏",          "⌘ \\"],
          ["切换 chat ↔ project", "⌘ ⇧ M"],
          ["打开设置",            "⌘ ,"],
        ].map(([k, v]) => (
          <div key={k} className="settings-card__row">
            <div className="settings-card__row-label">{k}</div>
            <kbd className="kbd">{v}</kbd>
          </div>
        ))}
      </div>
    </>
  );
}

/* ─── About ────────────────────────────────────────────── */

function AboutPage() {
  return (
    <>
      <SectionHead title="关于" />
      <div className="settings-card" style={{ padding: 24 }}>
        <div className="settings-card__about">
          <div className="settings__title-text" style={{ marginBottom: 12 }}>cogni</div>
          <div className="settings-card__about-tag">
            一个把云端账号 + 本地 runner 串起来的私人 AI 助手。
          </div>
          <dl className="settings-card__kv">
            <dt>Build</dt><dd>sp1.0.4-dev · e715bb5</dd>
            <dt>Cloud</dt><dd>cloud.ai-cognit.com</dd>
            <dt>Tenant</dt><dd>default</dd>
          </dl>
        </div>
      </div>
    </>
  );
}

/* ─── Atoms ────────────────────────────────────────────── */

function SectionHead({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="settings-section-head">
      <div>
        <div className="settings-section-head__title">{title}</div>
        {subtitle && <div className="settings-section-head__sub">{subtitle}</div>}
      </div>
      {action}
    </div>
  );
}

function Row({ icon, title, sub, right, current }: { icon: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode; current?: boolean }) {
  return (
    <div className={"settings-card__row" + (current ? " settings-card__row--current" : "")}>
      <div className="settings-card__row-icon">{icon}</div>
      <div className="settings-card__row-text">
        <div className="settings-card__row-title">{title}</div>
        {sub && <div className="settings-card__row-sub">{sub}</div>}
      </div>
      {right && <div className="settings-card__row-right">{right}</div>}
    </div>
  );
}
