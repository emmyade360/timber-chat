// The owner-only profile surface. Timber usernames are permanent identity
// handles, while an optional HTTPS avatar can be updated without touching keys.

import { useState } from "react";
import { useChatStore } from "../../store/chatStore.js";
import GrowthBar from "../../components/Level/GrowthBar.jsx";
import LevelBadge from "../../components/Level/LevelBadge.jsx";
import { updateCurrentUser, userMessage } from "../../lib/api.js";
import { SettingsGroup, SettingsRow } from "../../components/Settings/SettingsList.jsx";
import { Icons } from "../../components/Settings/icons.jsx";

function ProfileAvatar({ username, url, size = "large" }) {
  if (url) return <AvatarImage key={url} username={username} url={url} size={size} />;
  return <span className={`profile-avatar profile-avatar--${size} profile-avatar--fallback`}>{username?.[0]?.toUpperCase() ?? "?"}</span>;
}

function AvatarImage({ username, url, size }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className={`profile-avatar profile-avatar--${size} profile-avatar--fallback`}>{username?.[0]?.toUpperCase() ?? "?"}</span>;
  return <img className={`profile-avatar profile-avatar--${size}`} src={url} alt="Your profile" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

export default function Profile({ onOpenSettings }) {
  const { me } = useChatStore();
  const [editing, setEditing] = useState(false);

  if (!me) return <div className="screen"><div className="empty-state">Loading profile…</div></div>;
  if (editing) return <ProfileEditor me={me} onBack={() => setEditing(false)} />;

  const joined = me.created_at ? new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(me.created_at)) : "Unknown";

  return (
    <div className="screen profile-screen">
      <header className="screen-header">
        <h1 className="screen-title">Profile</h1>
        <button className="screen-header-action" onClick={onOpenSettings} aria-label="Open settings" title="Settings">
          {Icons.settings}
        </button>
      </header>

      <section className="profile-view-hero">
        <ProfileAvatar username={me.username} url={me.avatar_url} />
        <div className="profile-view-identity">
          <h2>
            @{me.username}
            <LevelBadge level={me.level} size={20} name={me.level_name} className="name-gem" />
          </h2>
          <p>Joined {joined}</p>
        </div>
        <button className="btn-wood profile-edit-button" onClick={() => setEditing(true)}>Edit profile</button>
      </section>

      <SettingsGroup
        title="Identity"
        footnote="Your username is permanent because it is bound to your non-custodial account identity. Timber never asks for an email or password."
      >
        <SettingsRow icon={Icons.profile} tint="wood" title="Username" subtitle={`@${me.username}`} value="Permanent" />
      </SettingsGroup>

      <SettingsGroup title="Growth" footnote="Growth reflects steady, consent-based connection — never message volume, time online, or popularity.">
        <div className="settings-item settings-item--plain">
          <GrowthBar me={me} badgeSize={34} />
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Privacy"
        footnote="Your photo is standard account metadata, not encrypted chat content. It is optional. Explore uses a separate, opt-in public card with its own photo and bio."
      >
        <SettingsRow
          icon={Icons.lock}
          tint="amber"
          title="Privacy & settings"
          subtitle="Notifications, security, and this device"
          onClick={onOpenSettings}
        />
      </SettingsGroup>
    </div>
  );
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
