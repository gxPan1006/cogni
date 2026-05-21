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
import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./icons.js";
import type { ApiClient, HostInfo } from "../transport/api.js";
import { useIdentities } from "../hooks/useIdentities.js";
import { useMe } from "../hooks/useMe.js";
import { Avatar } from "./Avatar.js";
import { AvatarCropper } from "./AvatarCropper.js";
import { useDevices } from "../hooks/useDevices.js";
import { useHosts } from "../hooks/useHosts.js";
import { useTheme } from "../hooks/useTheme.js";
import { useLocale } from "../hooks/useLocale.js";
import { LoadingRows, LoadingState } from "./LoadingState.js";
import "./settings.css";

type Page = "account" | "devices" | "hosts" | "customize" | "about";

export function SettingsPage({
  api,
  user = { name: "you", email: "—" },
  onClose,
}: {
  api: ApiClient;
  user?: { name: string; email: string; avatar?: string | null };
  onClose?: () => void;
}) {
  const [page, setPage] = useState<Page>("account");
  const { t } = useTranslation();

  return (
    <div className="settings">
      <div className="settings__nav">
        <div className="settings__title">
          {onClose && (
            <button className="btn btn-sm btn-ghost" onClick={onClose} title={t("settings.close")}>
              {Icon.x}
            </button>
          )}
          <div className="settings__title-text">{t("settings.title")}</div>
        </div>
        <nav className="settings__menu">
          {(
            [
              ["account",   t("settings.nav.account"),   Icon.user],
              ["devices",   t("settings.nav.devices"),   Icon.desktop],
              ["hosts",     t("settings.nav.hosts"),     Icon.flow],
              ["customize", t("settings.nav.customize"), Icon.spark],
              ["about",     t("settings.nav.about"),     Icon.shield],
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
        {page === "customize" && <CustomizePage />}
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
  user: { name: string; email: string; avatar?: string | null };
}) {
  const { t } = useTranslation();
  const { profile, update } = useMe(api);
  const { identities, loading, remove } = useIdentities(api);
  // Guard against locking yourself out — disable the last Disconnect button.
  const canRemove = identities.length > 1;

  // Live values: prefer the freshly-fetched profile, fall back to the prop
  // (JWT-derived) until /api/me resolves.
  const displayName = profile?.name ?? user.name;
  const avatar = profile?.avatar ?? user.avatar ?? null;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName);
  const [error, setError] = useState<string | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const saveName = async () => {
    const trimmed = draft.trim();
    if (trimmed.length > 50) { setError(t("settings.account.nameTooLong")); return; }
    setError(null);
    await update({ name: trimmed });   // "" clears to email-prefix on the server
    setEditing(false);
  };

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";   // allow re-picking the same file
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { setError(t("settings.account.avatarBadType")); return; }
    setError(null);
    setCropFile(f);
  };

  const saveAvatar = async (dataUrl: string) => {
    setCropFile(null);
    try {
      await update({ avatar: dataUrl });
    } catch {
      setError(t("settings.account.avatarTooLarge"));
    }
  };

  return (
    <>
      <SectionHead title={t("settings.account.title")} subtitle={t("settings.account.subtitle")} />
      <div className="settings-card">
        <Row
          icon={
            <button
              className="settings-avatar-btn"
              onClick={() => fileRef.current?.click()}
              title={t("settings.account.changeAvatar")}
            >
              <Avatar name={displayName} avatar={avatar} size={32} />
            </button>
          }
          title={
            editing ? (
              <input
                className="settings-card__rename-input"
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveName();
                  else if (e.key === "Escape") { setEditing(false); setError(null); }
                }}
              />
            ) : displayName
          }
          sub={`${user.email} · ${t("settings.account.tenantSuffix")}`}
          right={
            editing ? (
              <div className="settings-card__row-actions">
                <button className="btn btn-sm" onClick={() => { void saveName(); }}>{t("settings.account.renameSave")}</button>
                <button className="btn btn-sm btn-ghost" onClick={() => { setEditing(false); setError(null); }}>{t("settings.account.renameCancel")}</button>
              </div>
            ) : (
              <div className="settings-card__row-actions">
                <button className="btn btn-sm btn-ghost" onClick={() => { setDraft(displayName); setEditing(true); }}>{t("settings.account.rename")}</button>
                {avatar && (
                  <button className="btn btn-sm btn-ghost" style={{ color: "var(--bad)" }} onClick={() => { void update({ avatar: null }); }}>
                    {t("settings.account.removeAvatar")}
                  </button>
                )}
              </div>
            )
          }
        />
        {error && <div className="settings-card__foot" style={{ color: "var(--bad)" }}>{error}</div>}
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={pickFile} />
      </div>

      <SectionHead title={t("settings.account.methodsTitle")} subtitle={t("settings.account.methodsSubtitle")} />
      <div className="settings-card">
        {loading && <SettingsLoading label={t("settings.account.methodsLoadingLabel")} rows={2} />}
        {!loading && identities.length === 0 && (
          <div className="settings-card__foot"><span>{t("settings.account.noMethods")}</span></div>
        )}
        {!loading && identities.map((id) => (
          <Row
            key={`${id.kind}-${id.sub}`}
            icon={<span style={{ fontSize: 14 }}>{kindIcon(id.kind)}</span>}
            title={kindLabel(id.kind, t)}
            sub={id.sub}
            right={
              <button
                className="btn btn-sm"
                disabled={!canRemove}
                title={canRemove ? t("settings.account.unbindTitle") : t("settings.account.unbindDisabledTitle")}
                onClick={() => { void remove(id.kind, id.sub); }}
              >
                {t("settings.account.unbind")}
              </button>
            }
          />
        ))}
        <div className="settings-card__foot">
          <span style={{ color: "var(--warn)" }}>{Icon.shield}</span>
          <span>{t("settings.account.keepOneMethod")}</span>
        </div>
      </div>

      {cropFile && (
        <AvatarCropper file={cropFile} onConfirm={(url) => { void saveAvatar(url); }} onCancel={() => setCropFile(null)} />
      )}
    </>
  );
}

function kindLabel(kind: string, t: (key: string) => string): string {
  if (kind === "google") return t("settings.account.kindGoogle");
  if (kind === "email") return t("settings.account.kindEmail");
  if (kind === "dev") return t("settings.account.kindDev");
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
  const { t } = useTranslation();
  const { devices, loading, revoke } = useDevices(api);
  const revokeOthers = async () => {
    for (const d of devices) if (!d.isCurrent) await revoke(d.id);
  };
  const hasOthers = devices.some((d) => !d.isCurrent);

  return (
    <>
      <SectionHead
        title={t("settings.devices.title")}
        subtitle={t("settings.devices.subtitle")}
        action={
          <button className="btn btn-sm" disabled={!hasOthers} onClick={() => { void revokeOthers(); }}>
            {t("settings.devices.revokeOthers")}
          </button>
        }
      />
      <div className="settings-card">
        {loading && <SettingsLoading label={t("settings.devices.loadingLabel")} rows={3} />}
        {!loading && devices.length === 0 && (
          <div className="settings-card__foot"><span>{t("settings.devices.none")}</span></div>
        )}
        {!loading && devices.map((d) => (
          <Row
            key={d.id}
            current={d.isCurrent}
            icon={deviceKindIcon(d.deviceName)}
            title={d.deviceName}
            sub={`${fmtRelative(d.lastSeenAt, t)}${d.ip ? " · IP " + d.ip : ""}`}
            right={
              d.isCurrent
                ? <span className="settings-card__current-tag">{t("settings.devices.current")}</span>
                : <button className="btn btn-sm" onClick={() => { void revoke(d.id); }}>{t("settings.devices.revoke")}</button>
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

function fmtRelative(iso: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return t("settings.devices.justNow");
  if (diff < 3_600_000) return t("settings.devices.minutesAgo", { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("settings.devices.hoursAgo", { n: Math.floor(diff / 3_600_000) });
  return new Date(iso).toLocaleDateString();
}

/* ─── Hosts ────────────────────────────────────────────── */

function HostsPage({ api }: { api: ApiClient }) {
  const { t } = useTranslation();
  const { hosts, loading, rename, remove } = useHosts(api);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  return (
    <>
      <SectionHead
        title={t("settings.hosts.title")}
        subtitle={t("settings.hosts.subtitle")}
      />
      <div className="settings-card">
        {loading && <SettingsLoading label={t("settings.hosts.loadingLabel")} rows={3} />}
        {!loading && hosts.length === 0 && (
          <div className="settings-card__foot"><span>{t("settings.hosts.none")}</span></div>
        )}
        {!loading && hosts.map((h) => {
          const isEditing = editingId === h.id;
          return (
            <div key={h.id}>
            <Row
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
              sub={`${h.status}${h.lastSeen ? " · " + t("settings.hosts.lastSeen", { when: fmtRelative(h.lastSeen, t) }) : ""}`}
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
                        title={t("settings.hosts.rename")}
                        onClick={() => { setEditingId(h.id); setDraftName(h.name); }}
                      >{Icon.edit}</button>
                      <button
                        className="btn btn-sm btn-ghost"
                        style={{ color: "var(--bad)" }}
                        title={t("settings.hosts.remove")}
                        onClick={() => { void remove(h.id); }}
                      >{Icon.trash}</button>
                    </>
                  )}
                </div>
              }
            />
            <HostProjectsRootRow api={api} host={h} />
            <HostKeepAwakeRow api={api} host={h} />
            </div>
          );
        })}
        <div className="settings-card__foot">
          <span style={{ color: "var(--muted)" }}>+</span>
          <span>{t("settings.hosts.addHint")}</span>
        </div>
      </div>
    </>
  );
}

/**
 * Per-host editable "projects root" — the folder under which New Project
 * pre-fills a repo path. Renders an input + 保存 button beneath each host row.
 * When the host pins the root via COGNI_PROJECTS_ROOT, the field is read-only
 * and shows a "由环境变量锁定" hint.
 */
function HostProjectsRootRow({ api, host }: { api: ApiClient; host: HostInfo }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(host.projectsRoot ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = host.projectsRootLocked === true;
  return (
    <div className="settings__projroot">
      <label className="field__label">{t("settings.hosts.projectsRootLabel")}</label>
      <div className="np__path">
        <input
          className="input"
          value={value}
          disabled={locked || saving}
          placeholder={t("settings.hosts.projectsRootPlaceholder")}
          onChange={(e) => { setValue(e.target.value); setSaved(false); setError(null); }}
        />
        <button
          className="btn btn-sm"
          disabled={locked || saving || value.trim().length === 0}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              const r = await api.setProjectsRoot(host.id, value.trim());
              setValue(r.projectsRoot);
              setSaved(true);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setSaving(false);
            }
          }}
        >{t("settings.hosts.save")}</button>
      </div>
      <div className="field__hint">
        {locked
          ? t("settings.hosts.projectsRootLocked")
          : error
            ? error
            : saved
              ? t("settings.hosts.saved")
              : t("settings.hosts.projectsRootHint")}
      </div>
    </div>
  );
}

/**
 * Per-host "keep awake" toggle — when on, the host daemon blocks the machine
 * from sleeping so remote clients (other browsers, phone web) can always reach
 * it. Default on. Read-only with a hint when pinned by COGNI_KEEP_AWAKE.
 */
function HostKeepAwakeRow({ api, host }: { api: ApiClient; host: HostInfo }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(host.keepAwake !== false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = host.keepAwakeLocked === true;

  const apply = async (next: boolean) => {
    if (locked || saving || next === enabled) return;
    setSaving(true);
    setError(null);
    const prev = enabled;
    setEnabled(next); // optimistic
    try {
      const r = await api.setKeepAwake(host.id, next);
      setEnabled(r.enabled);
    } catch (e) {
      setEnabled(prev); // revert on failure
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings__projroot">
      <label className="field__label">{t("settings.hosts.keepAwakeLabel")}</label>
      <div className="seg">
        <button
          className={"seg__btn" + (enabled ? " is-on" : "")}
          disabled={locked || saving}
          onClick={() => { void apply(true); }}
        >{t("settings.hosts.on")}</button>
        <button
          className={"seg__btn" + (!enabled ? " is-on" : "")}
          disabled={locked || saving}
          onClick={() => { void apply(false); }}
        >{t("settings.hosts.off")}</button>
      </div>
      <div className="field__hint">
        {locked
          ? t("settings.hosts.keepAwakeLocked")
          : error
            ? error
            : enabled
              ? t("settings.hosts.keepAwakeOnHint")
              : t("settings.hosts.keepAwakeOffHint")}
      </div>
    </div>
  );
}

/* ─── Customize ───────────────────────────────────────── */

function CustomizePage() {
  const { t } = useTranslation();
  const { pref, setPref } = useTheme();
  const { locale, setLocale } = useLocale();
  const sub =
    pref === "system" ? t("settings.customize.themeSystemSub")
    : pref === "dark" ? t("settings.customize.themeDarkSub")
    : t("settings.customize.themeLightSub");
  return (
    <>
      <SectionHead title={t("settings.customize.title")} subtitle={t("settings.customize.subtitle")} />

      <div className="settings-card">
        <Row
          icon={Icon.globe}
          title={t("settings.language.title")}
          sub={t("settings.language.sub")}
          right={
            <div className="seg">
              <button className={"seg__btn" + (locale === "zh" ? " is-on" : "")} onClick={() => setLocale("zh")}>{t("settings.language.zh")}</button>
              <button className={"seg__btn" + (locale === "en" ? " is-on" : "")} onClick={() => setLocale("en")}>{t("settings.language.en")}</button>
            </div>
          }
        />
      </div>

      <div className="settings-card">
        <Row
          icon={pref === "dark" ? Icon.moon : Icon.sun}
          title={t("settings.customize.themeTitle")}
          sub={sub}
          right={
            <div className="seg">
              <button className={"seg__btn" + (pref === "light"  ? " is-on" : "")} onClick={() => setPref("light")}>{t("settings.customize.themeLight")}</button>
              <button className={"seg__btn" + (pref === "dark"   ? " is-on" : "")} onClick={() => setPref("dark")}>{t("settings.customize.themeDark")}</button>
              <button className={"seg__btn" + (pref === "system" ? " is-on" : "")} onClick={() => setPref("system")}>{t("settings.customize.themeSystem")}</button>
            </div>
          }
        />
      </div>

      <SectionHead title={t("settings.customize.shortcutsTitle")} subtitle={t("settings.customize.shortcutsSubtitle")} />
      <div className="settings-card">
        {[
          [t("settings.customize.shortcutNewChat"),         "⌘ N"],
          [t("settings.customize.shortcutSearch"),          "⌘ K"],
          [t("settings.customize.shortcutCollapseSidebar"), "⌘ \\"],
          [t("settings.customize.shortcutToggleMode"),      "⌘ ⇧ M"],
          [t("settings.customize.shortcutOpenSettings"),    "⌘ ,"],
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
  const { t } = useTranslation();
  return (
    <>
      <SectionHead title={t("settings.about.title")} />
      <div className="settings-card" style={{ padding: 24 }}>
        <div className="settings-card__about">
          <div className="settings__title-text" style={{ marginBottom: 12 }}>cogni</div>
          <div className="settings-card__about-tag">
            {t("settings.about.tagline")}
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

function SettingsLoading({ label, rows }: { label: string; rows: number }) {
  const { t } = useTranslation();
  return (
    <div className="settings-card__loading" aria-busy="true">
      <LoadingState variant="inline" title={t("settings.syncing", { label })} />
      <LoadingRows rows={rows} compact />
    </div>
  );
}
