// The owner-only profile surface. Timber usernames are permanent identity
// handles, while an optional HTTPS avatar can be updated without touching keys.

import { useState } from "react";
import { useChatStore } from "../../store/chatStore.js";
import { updateCurrentUser, userMessage } from "../../lib/api.js";
import { Icons } from "../../components/Settings/icons.jsx";
import Modal from "../../components/Modal.jsx";

function ProfileAvatar({ username, url, size = "large" }) {
  if (url) return <AvatarImage key={url} username={username} url={url} size={size} />;
  return <span className={`profile-avatar profile-avatar--${size} profile-avatar--fallback`}>{username?.[0]?.toUpperCase() ?? "?"}</span>;
}

function AvatarImage({ username, url, size }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className={`profile-avatar profile-avatar--${size} profile-avatar--fallback`}>{username?.[0]?.toUpperCase() ?? "?"}</span>;
  return <img className={`profile-avatar profile-avatar--${size}`} src={url} alt="Your profile" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

export default function Profile({ onOpenSettings, onOpenVault, theme, onThemeChange }) {
  const { me, conversations, syncing } = useChatStore();
  const [editing, setEditing] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);

  if (!me) return <div className="screen"><div className="empty-state">Loading profile…</div></div>;
  if (editing) return <ProfileEditor me={me} onBack={() => setEditing(false)} />;

  return (
    <div className="screen profile-screen">
      <header className="timber-header">
        <span className="timber-header-mark" aria-hidden="true">◈</span>
        <h1>Timber</h1>
        <button className="screen-header-action" onClick={() => onOpenSettings()} aria-label="Open settings" title="Settings">
          {Icons.settings}
        </button>
      </header>

      <section className="profile-reference-hero">
        <ProfileAvatar username={me.username} url={me.avatar_url} />
        <button className="profile-avatar-edit" onClick={() => setEditing(true)} aria-label="Edit profile photo">✎</button>
        <div className="profile-view-identity">
          <h2>
            {me.username}
          </h2>
          <p className="profile-secure"><span>◉</span> Secure</p>
        </div>
      </section>

      <section className="profile-vault-card">
        <div className="profile-storage-row">
          <span className="profile-row-icon">☁</span>
          <span><strong>Storage</strong><small>{syncing ? "Securely syncing" : "Encrypted on this device"}</small></span>
          <span className="profile-storage-value"><b>{conversations.length}</b><small> Active rings</small></span>
        </div>
      </section>

      <section className="profile-actions" aria-label="Profile settings">
        <ProfileRow icon="⚿" title="Recovery phrase" subtitle="Back up your identity" onClick={() => onOpenSettings("phrase")} />
        <ProfileRow icon="♧" title="Notifications" subtitle="Alerts and sounds" toggle onClick={() => onOpenSettings("notifications")} />
        <ProfileRow icon="◉" title="Privacy" subtitle="Connections and discovery" onClick={() => onOpenVault("explore")} />
        <ProfileRow icon="◌" title="Theme" subtitle={`${theme[0].toUpperCase()}${theme.slice(1)}${theme === "dark" ? " (Default)" : ""}`} onClick={() => setThemeOpen(true)} />
      </section>

      {themeOpen && (
        <Modal title="Theme" onClose={() => setThemeOpen(false)}>
          <p className="panel-note">This device only. It never leaves your encrypted vault.</p>
          {[
            ["dark", "Dark", "The Timber default"],
            ["light", "Light", "A brighter local surface"],
            ["system", "System", "Follow this device"],
          ].map(([value, label, note]) => (
            <button key={value} className={`theme-choice ${theme === value ? "theme-choice--active" : ""}`} onClick={() => { onThemeChange(value); setThemeOpen(false); }}>
              <span><strong>{label}</strong><small>{note}</small></span><span>{theme === value ? "✓" : ""}</span>
            </button>
          ))}
        </Modal>
      )}
    </div>
  );
}

function ProfileRow({ icon, title, subtitle, onClick, toggle = false }) {
  return <button className="profile-action-row" onClick={onClick}>
    <span className="profile-action-icon">{icon}</span>
    <span><strong>{title}</strong><small>{subtitle}</small></span>
    {toggle ? <span className="profile-toggle" aria-hidden="true"><i /></span> : <span className="profile-row-chevron">›</span>}
  </button>;
}

function ProfileEditor({ me, onBack }) {
  const { setMe } = useChatStore();
  const [avatarUrl, setAvatarUrl] = useState(me.avatar_url ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const save = async () => {
    setBusy(true);
    setNotice("");
    try {
      const response = await updateCurrentUser({ avatar_url: avatarUrl.trim() || null });
      setMe(response.data);
      setNotice("Profile saved.");
    } catch (error) {
      setNotice(userMessage(error, "Could not update your profile. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen profile-screen">
      <header className="screen-header">
        <button className="screen-header-back" onClick={onBack} aria-label="Back to profile">{Icons.back}</button>
        <h1 className="screen-title">Edit profile</h1>
      </header>

      <section className="panel profile-editor">
        <ProfileAvatar username={me.username} url={avatarUrl.trim() || null} />
        <div className="field-group">
          <label className="field-label" htmlFor="profile-avatar-url">Profile photo URL</label>
          <input
            id="profile-avatar-url"
            className="glass-input"
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoComplete="url"
            spellCheck="false"
            placeholder="https://…"
            value={avatarUrl}
            onChange={(event) => setAvatarUrl(event.target.value)}
          />
          <p className="field-help">Use an HTTPS image URL. Clear this field to remove your profile photo.</p>
        </div>

        <div className="field-group">
          <label className="field-label">Username</label>
          <div className="readonly-field">@{me.username}</div>
          <p className="field-help">Usernames cannot be changed after registration.</p>
        </div>

        {notice && <p className={notice === "Profile saved." ? "field-ok" : "form-error"}>{notice}</p>}
        <button className="btn-wood btn-block" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save profile"}</button>
        {me.avatar_url && <button className="btn-ghost btn-block" disabled={busy} onClick={() => setAvatarUrl("")}>Remove profile photo</button>}
        <button className="btn-ghost btn-block" disabled={busy} onClick={onBack}>Back</button>
      </section>
    </div>
  );
}
