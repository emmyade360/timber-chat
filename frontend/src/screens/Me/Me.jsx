// Settings.
//
// An organised list rather than a page of stacked panels: every row is a tinted
// icon, a label, and one trailing element that says what the row does. The long
// content -- the twenty-one stage ladder, the invite panel, the device transfer
// -- lives on its own subpage, so the root stays scannable and the reader is
// never scrolling past a wall of explanation to reach a switch.

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useChatStore } from "../../store/chatStore.js";
import LevelBadge from "../../components/Level/LevelBadge.jsx";
import GrowthBar from "../../components/Level/GrowthBar.jsx";
import InvitePanel from "../../components/Invite/InvitePanel.jsx";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "../../components/Settings/SettingsList.jsx";
import { Icons } from "../../components/Settings/icons.jsx";
import {
  MAX_PIN_LENGTH,
  MIN_PIN_LENGTH,
  changePin,
  eraseOnFailureEnabled,
  exportVaultTransfer,
  forgetVaultIdentity,
  isValidPin,
  isVaultSecured,
  openDeviceVault,
  setEraseOnFailure,
  setVaultIdentity,
  unlockVault,
  vaultIdentity,
  wipeDevice,
} from "../../crypto/vault.js";
import SecureAccount from "../Secure/SecureAccount.jsx";
import {
  clearDigest,
  notificationSettings,
  pendingDigestCount,
  updateNotificationSettings,
} from "../../lib/notifications.js";
import { disablePushAlerts, pushReadiness, pushSupported, PUSH_STATUS } from "../../lib/push.js";
import { enableAllAlerts, pushStatusMessage } from "../../lib/alerts.js";
import { LOCK_POLICIES, lockPolicyDescription, normalizeLockPolicy } from "../../lib/lockPolicy.js";
import { getHealth } from "../../lib/api.js";
import Modal from "../../components/Modal.jsx";

export default function Settings({ onBack, onOpenExplore, onOpenInstall, onSignOut, onWiped, lockPolicy = LOCK_POLICIES.twoHours, onLockPolicyChange, initialPanel = null }) {
  const { me, ladder } = useChatStore();
  const [panel, setPanel] = useState(() => ["phrase", "pin", "wipe", "secure"].includes(initialPanel) ? initialPanel : null);
  // Whether this device has a PIN at all. An account created since the two-tap
  // signup has none until it is offered one, and several rows below mean
  // different things in each state.
  const [secured, setSecured] = useState(true);

  useEffect(() => {
    let ignore = false;
    isVaultSecured()
      .then((value) => { if (!ignore) setSecured(value); })
      .catch(() => {});
    return () => { ignore = true; };
  }, [panel]);
  const [page, setPage] = useState(() => initialPanel === "notifications" ? "notifications" : "root");

  if (!me) return <div className="screen"><div className="empty-state">Loading…</div></div>;

  if (page === "growth") return <GrowthPage me={me} ladder={ladder} onBack={() => setPage("root")} />;
  if (page === "invite") return <SubPage title="Invite friends" onBack={() => setPage("root")}><InvitePanel /></SubPage>;
  if (page === "transfer") return <TransferPage onBack={() => setPage("root")} />;
  if (page === "notifications") return <SubPage title="Notifications" onBack={() => setPage("root")}><NotificationGroup /></SubPage>;

  return (
    <div className="screen">
      <header className="screen-header">
        <button className="screen-header-back" onClick={onBack} aria-label="Back to profile">‹</button>
        <h1 className="screen-title">Settings</h1>
      </header>

      <div className="settings-identity">
        <LevelBadge level={me.level} size={54} />
        <div className="settings-identity-text">
          <span className="settings-identity-name">
            @{me.username}
            <LevelBadge level={me.level} size={16} name={me.level_name} className="name-gem" />
          </span>
          <span className="settings-identity-sub">{me.level_name}</span>
        </div>
      </div>

      <SettingsGroup title="Growth">
        <SettingsRow
          icon={Icons.growth}
          tint="green"
          title="Your growth path"
          subtitle={me.next_level_name ? `${me.level_name} — growing towards ${me.next_level_name}` : `${me.level_name} — your path is complete`}
          onClick={() => setPage("growth")}
        />
        <SettingsRow
          icon={Icons.invite}
          tint="amber"
          title="Invite friends"
          subtitle="Start an encrypted conversation with someone you trust"
          onClick={() => setPage("invite")}
        />
      </SettingsGroup>

      <SettingsGroup title="Notifications">
        <SettingsRow icon={Icons.bell} tint="amber" title="Private notifications" subtitle="Alerts and sounds for this device" onClick={() => setPage("notifications")} />
      </SettingsGroup>

      <SettingsGroup
        title="Privacy"
        footnote="Chats are private and encrypted. Explore is separate, opt-in public profile data for finding friends; it never uses device location or open DMs."
      >
        <SettingsRow
          icon={Icons.compass}
          tint="teal"
          title="Explore privacy"
          subtitle="Manage your opt-in public card"
          onClick={onOpenExplore}
        />
      </SettingsGroup>

      <SettingsGroup title="This device">
        <SettingsRow
          icon={Icons.install}
          tint="wood"
          title="Install Timber"
          subtitle="A focused, full-screen app"
          onClick={onOpenInstall}
        />
        <SettingsRow
          icon={Icons.transfer}
          tint="wood"
          title="Transfer to a new device"
          subtitle="Move your encrypted vault across"
          onClick={() => setPage("transfer")}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Account & security"
        footnote="Timber has no password and no email. Your twelve-word phrase is the only way back in — keep it somewhere safe and never share it. Auto-lock defaults to two hours; turning it off keeps this device signed in until you lock it yourself, so only do that on a device only you use."
      >
        <SettingsRow icon={Icons.key} tint="amber" title="Recovery phrase" subtitle="Twelve words that are your account" onClick={() => setPanel("phrase")} />
        {secured ? (
          <SettingsRow icon={Icons.pin} tint="wood" title="Change PIN" subtitle={`${MIN_PIN_LENGTH}+ digits`} onClick={() => setPanel("pin")} />
        ) : (
          <SettingsRow icon={Icons.pin} tint="amber" title="Set a PIN" subtitle="Back up your phrase and lock this device" onClick={() => setPanel("secure")} />
        )}
        <LockScreenName />
        {secured && <EraseOnFailure />}
        <SettingsRow
          icon={Icons.lock}
          tint="wood"
          title="Auto-lock"
          subtitle={lockPolicyDescription(lockPolicy)}
          control={(
            <select
              className="settings-select"
              aria-label="Auto-lock preference"
              value={normalizeLockPolicy(lockPolicy)}
              onChange={(event) => onLockPolicyChange?.(event.target.value)}
            >
              <option value={LOCK_POLICIES.always}>Every launch</option>
              <option value={LOCK_POLICIES.twoHours}>After 2 hours</option>
              <option value={LOCK_POLICIES.week}>After a week</option>
              <option value={LOCK_POLICIES.never}>Never automatically</option>
            </select>
          )}
        />
        <SettingsRow icon={Icons.lock} tint="wood" title="Lock Timber" subtitle="Require your PIN to come back" action onClick={onSignOut} />
      </SettingsGroup>

      <BuildGroup />

      <SettingsGroup>
        <SettingsRow icon={Icons.trash} tint="danger" title="Remove this device" subtitle="Erase this device’s copy of your account" destructive action onClick={() => setPanel("wipe")} />
      </SettingsGroup>

      {panel === "secure" && (
        <SecureAccount onDone={() => setPanel(null)} onCancel={() => setPanel(null)} />
      )}
      {panel === "phrase" && <RevealPhrase onClose={() => setPanel(null)} />}
      {panel === "pin" && <ChangePin onClose={() => setPanel(null)} />}
      {panel === "wipe" && <WipeDevice onClose={() => setPanel(null)} onWiped={onWiped} />}
    </div>
  );
}

/** A drilled-into settings page: same header treatment, one topic. */
function SubPage({ title, onBack, children }) {
  return (
    <div className="screen">
      <header className="screen-header">
        <button className="screen-header-back" onClick={onBack} aria-label="Back to settings">‹</button>
        <h1 className="screen-title">{title}</h1>
      </header>
      {children}
    </div>
  );
}

/** The full ladder and how growth is earned. Long, so it gets its own page. */
function GrowthPage({ me, ladder, onBack }) {
  return (
    <SubPage title="Your growth path" onBack={onBack}>
      <section className="profile-hero">
        <GrowthBar me={me} variant="hero" badgeSize={96} />
        <div className="stat-row">
          <Stat label="Growth" value={me.growth_points.toLocaleString()} />
          <Stat label="Steady days" value={me.streak_days} />
        </div>
      </section>

      {ladder?.practices && (
        <section className="panel">
          <h3 className="section-title">Connection practices</h3>
          <ul className="earn-list">
            {ladder.practices.map((rule) => (
              <li key={rule.kind}>
                <span>{rule.label}</span>
                <span className="earn-points">
                  +{rule.points} growth
                  <span className="earn-cap">max {rule.daily_cap}/day</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="panel-note">
            Growth reflects steady, consent-based connection — never message volume,
            time online, popularity, or anything you say. It is not a health score.
            Daily practices are capped at {ladder.daily_growth_ceiling} growth points.
          </p>
        </section>
      )}

      {ladder?.stages && (
        <ol className="ladder">
          {ladder.stages.map((tier) => {
            const reached = me.level >= tier.level;
            const current = me.level === tier.level;
            return (
              <li key={tier.level} className={`ladder-row ${reached ? "" : "ladder-row--locked"} ${current ? "ladder-row--current" : ""}`}>
                <LevelBadge level={tier.level} size={30} />
                <span className="ladder-name">{tier.name}</span>
                <span className="ladder-growth">{tier.threshold.toLocaleString()} growth</span>
                {current && <span className="ladder-you">you</span>}
              </li>
            );
          })}
        </ol>
      )}
    </SubPage>
  );
}

function TransferPage({ onBack }) {
  const [transfer, setTransfer] = useState("");
  const [notice, setNotice] = useState("");
  return (
    <SubPage title="Transfer device" onBack={onBack}>
      <section className="panel">
        <p className="panel-note">
          {navigator.onLine ? "Sync is available: " : "You are offline: "}
          Timber restores encrypted ciphertext after you sign in on another device. The
          server cannot open it.
        </p>
        {!transfer ? (
          <button className="btn-wood btn-block" onClick={async () => {
            try { setTransfer(await exportVaultTransfer()); }
            catch { setNotice("Could not prepare the encrypted transfer code. Try again while Timber is unlocked."); }
          }}>Show encrypted transfer QR</button>
        ) : (
          <>
            <div className="safety-qr" aria-label="Encrypted device transfer QR code"><QRCodeSVG value={transfer} size={176} includeMargin /></div>
            <p className="onboard-warning">
              This QR is an encrypted copy of your device vault, not your recovery phrase.
              Treat it like a password export: show it only to your new device, which must
              also enter this device’s current PIN.
            </p>
            <button className="btn-ghost btn-block" onClick={async () => {
              try { await navigator.clipboard.writeText(transfer); setNotice("Encrypted transfer code copied."); }
              catch { setNotice("Copy is unavailable in this browser; scan the QR on your new device."); }
            }}>Copy encrypted transfer code</button>
            <button className="btn-ghost btn-block" onClick={() => setTransfer("")}>Hide transfer code</button>
          </>
        )}
        {notice && <p className="field-ok">{notice}</p>}
      </section>
    </SubPage>
  );
}

/**
 * Notification preferences.
 *
 * The master switch is what asks the browser for permission; the rows beneath
 * it only appear once it is on, because a switch that cannot take effect is
 * worse than an absent one.
 */
function NotificationGroup() {
  const [settings, setSettings] = useState({ enabled: false, digest: false, checkIns: false });
  const [digestCount, setDigestCount] = useState(0);
  const [calls, setCalls] = useState(false);
  const [pushStatus, setPushStatus] = useState(PUSH_STATUS.notSubscribed);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [saved, count, readiness] = await Promise.all([
          notificationSettings(),
          pendingDigestCount(),
          pushReadiness(),
        ]);
        if (!live) return;
        setSettings(saved);
        setDigestCount(count);
        setPushStatus(readiness.status);
        setCalls(readiness.status === PUSH_STATUS.ready);
      } catch { /* preferences are optional */ }
    })();
    return () => { live = false; };
  }, []);

  const patch = async (next) => setSettings(await updateNotificationSettings(next));

  /**
   * The master switch grants both mechanisms at once.
   *
   * One browser permission covers the in-page notification raised while the tab
   * is hidden and the push that arrives when Timber is closed, and they cover
   * different moments. Turning on only the first left people unreachable in
   * exactly the case they cared about.
   */
  const toggleMaster = async (on) => {
    setNotice("");
    if (!on) {
      try {
        const result = await disablePushAlerts();
        await patch({ enabled: false });
        setCalls(false);
        setPushStatus(PUSH_STATUS.notSubscribed);
        if (result && !result.serverRemoved) setNotice("Background alerts are off on this device. The server will clean up its old registration when it is reachable again.");
      } catch (error) {
        setNotice(error.message || "Could not turn off background notifications. Try again.");
      }
      return;
    }
    try {
      const { push } = await enableAllAlerts();
      setSettings(await notificationSettings());
      setCalls(push);
      const readiness = await pushReadiness();
      setPushStatus(readiness.status);
      if (!push && pushSupported()) {
        setNotice(pushStatusMessage(readiness.status));
      }
    } catch (error) {
      setNotice(error.message || "Notifications are unavailable or were not allowed by this browser.");
    }
  };

  const toggleCalls = async (on) => {
    setNotice("");
    try {
      if (on) {
        const { push } = await enableAllAlerts();
        setSettings(await notificationSettings());
        setCalls(push);
        const readiness = await pushReadiness();
        setPushStatus(readiness.status);
        if (!push && pushSupported()) setNotice(pushStatusMessage(readiness.status));
      } else {
        await disablePushAlerts();
        setCalls(false);
        setPushStatus(PUSH_STATUS.notSubscribed);
      }
    } catch (error) { setNotice(error.message || "Call alerts could not be changed."); }
  };

  return (
    <SettingsGroup
      title="Notifications"
      footnote="Off by default. Covers new messages, friend requests, accepted requests, and incoming calls. Notifications never include message text. Turning on the last switch also lets calls and messages reach you while Timber is closed, which means the push service is told that a message arrived and who from — never what it said. Per-chat mutes apply while Timber is open; they cannot be honoured while it is closed."
    >
      <SettingsRow
        icon={Icons.bell}
        tint="amber"
        title="Private notifications"
        subtitle={settings.enabled ? "On for this device" : "Off"}
        control={<SettingsSwitch checked={settings.enabled} onChange={toggleMaster} label="Private notifications" />}
      />
      {settings.enabled && (
        <>
          <SettingsRow
            icon={Icons.moon}
            tint="wood"
            title="Quiet digest"
            subtitle={digestCount > 0 ? `${digestCount} waiting` : "Collect messages instead of alerting"}
            control={<SettingsSwitch checked={settings.digest} onChange={(value) => patch({ digest: value })} label="Quiet digest" />}
          />
          <SettingsRow
            icon={Icons.clock}
            tint="wood"
            title="Check-in reminders"
            subtitle="A generic nudge while Timber is open"
            control={<SettingsSwitch checked={settings.checkIns} onChange={(value) => patch({ checkIns: value })} label="Check-in reminders" />}
          />
        </>
      )}
      <SettingsRow
        icon={Icons.phone}
        tint="green"
        title="Alerts when Timber is closed"
        subtitle={pushStatusMessage(pushStatus)}
        control={<SettingsSwitch checked={calls} onChange={toggleCalls} label="Alerts when Timber is closed" disabled={!pushSupported()} />}
      />
      {digestCount > 0 && (
        <SettingsRow
          icon={Icons.moon}
          tint="wood"
          title="Clear quiet digest"
          value={digestCount}
          action
          onClick={async () => { await clearDigest(); setDigestCount(0); }}
        />
      )}
      {notice && <p className="settings-notice">{notice}</p>}
    </SettingsGroup>
  );
}

/**
 * The version this device is running, and the one the relay is running.
 *
 * The first useful question about any bug report is which build the person is
 * on, and an installed PWA can sit on a cached shell for a while after a
 * release, so the two are shown separately.
 */
function BuildGroup() {
  const [server, setServer] = useState(null);
  useEffect(() => {
    let live = true;
    getHealth()
      .then(({ data }) => { if (live) setServer(data.version ?? "unknown"); })
      .catch(() => { if (live) setServer("unreachable"); });
    return () => { live = false; };
  }, []);

  return (
    <SettingsGroup title="About" footnote="Quote the app version if you ever report a problem. It never identifies you.">
      <SettingsRow icon={Icons.info} tint="wood" title="App" subtitle="This device" value={__APP_VERSION__} />
      <SettingsRow icon={Icons.info} tint="wood" title="Relay" subtitle="Timber service" value={server ?? "…"} />
    </SettingsGroup>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}


/**
 * Re-asks for the PIN: the phrase is the account, so showing it needs proof.
 *
 * A device with no PIN has nothing to prove with, and `unlockVault` would accept
 * any input on one -- so the prompt is skipped rather than faked, and the phrase
 * is shown with the offer to protect it.
 */
function RevealPhrase({ onClose }) {
  const [pin, setPin] = useState("");
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState("");
  const [secured, setSecured] = useState(null);

  useEffect(() => {
    let ignore = false;
    isVaultSecured()
      .then(async (value) => {
        if (ignore) return;
        setSecured(value);
        if (!value) setPhrase(await openDeviceVault());
      })
      .catch(() => { if (!ignore) setSecured(true); });
    return () => { ignore = true; };
  }, []);

  const reveal = async () => {
    try {
      setPhrase(await unlockVault(pin));
      setError("");
    } catch (caught) {
      setError(caught.message);
    }
  };

  if (secured === null) return null;

  return (
    <Modal title="Recovery phrase" onClose={onClose}>
      {phrase ? (
        <>
          <ol className="phrase-grid">
            {phrase.split(" ").map((word, index) => (
              <li key={`${word}-${index}`} className="phrase-word">
                <span className="phrase-index">{index + 1}</span>
                {word}
              </li>
            ))}
          </ol>
          <p className="onboard-warning">
            Anyone with these words has your account and can read your messages.
          </p>
          {!secured && (
            <p className="panel-note">
              This device has no PIN yet. Once your phrase is written down, setting one from
              Settings locks the copy stored here.
            </p>
          )}
          <button className="btn-wood btn-block" onClick={onClose}>Done</button>
        </>
      ) : (
        <>
          <p className="panel-note">Confirm your PIN to reveal your phrase.</p>
          <input
            className="glass-input"
            type="password"
            autoFocus
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && reveal()}
          />
          {error && <p className="form-error">{error}</p>}
          <button className="btn-wood btn-block" disabled={!pin} onClick={reveal}>Reveal</button>
          <button className="btn-ghost btn-block" onClick={onClose}>Cancel</button>
        </>
      )}
    </Modal>
  );
}

/**
 * Whether the lock screen greets its owner by name.
 *
 * On means a username, avatar and growth stage sit in the clear beside the
 * sealed vault, so the screen can recognise someone before it has any key to
 * decrypt with. That is a real trade and it is stated plainly, because anyone
 * holding the device learns which account it is without knowing the PIN.
 */
function LockScreenName() {
  const { me } = useChatStore();
  const [on, setOn] = useState(true);

  useEffect(() => {
    let ignore = false;
    vaultIdentity()
      .then((identity) => { if (!ignore) setOn(Boolean(identity?.username)); })
      .catch(() => {});
    return () => { ignore = true; };
  }, []);

  const toggle = async (value) => {
    setOn(value);
    try {
      if (!value) await forgetVaultIdentity();
      else if (me) {
        await setVaultIdentity({
          userId: me.id,
          username: me.username,
          avatarUrl: me.avatar_url ?? null,
          level: me.level ?? null,
          levelName: me.level_name ?? null,
        });
      }
    } catch {
      // A preference that cannot be written is not worth failing a screen over;
      // the next toggle tries again.
    }
  };

  return (
    <SettingsRow
      icon={Icons.profile}
      tint="wood"
      title="Show my name when locked"
      subtitle={on ? "The lock screen greets you" : "The lock screen stays anonymous"}
      control={<SettingsSwitch checked={on} onChange={toggle} label="Show my name when locked" />}
    />
  );
}

/**
 * The opt-in self-destruct.
 *
 * Off by default since the phrase began resetting a forgotten PIN: erasing on
 * failed attempts costs a real person their history to slow an attacker who can
 * copy the stored blob and brute force it offline regardless.
 */
function EraseOnFailure() {
  const [on, setOn] = useState(false);

  useEffect(() => {
    let ignore = false;
    eraseOnFailureEnabled()
      .then((value) => { if (!ignore) setOn(value); })
      .catch(() => {});
    return () => { ignore = true; };
  }, []);

  const toggle = async (value) => {
    setOn(value);
    await setEraseOnFailure(value).catch(() => {});
  };

  return (
    <SettingsRow
      icon={Icons.trash}
      tint="danger"
      title="Erase after 10 failed attempts"
      subtitle={on ? "This device erases itself; restore with your phrase" : "Wrong PINs are refused, nothing is deleted"}
      control={<SettingsSwitch checked={on} onChange={toggle} label="Erase after 10 failed attempts" />}
    />
  );
}

function ChangePin({ onClose }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const submit = async () => {
    try {
      await changePin(current, next);
      setDone(true);
    } catch (caught) {
      setError(caught.message);
    }
  };

  return (
    <Modal title="Change PIN" onClose={onClose}>
      {done ? (
        <>
          <p className="field-ok">Your PIN has been changed.</p>
          <button className="btn-wood btn-block" onClick={onClose}>Done</button>
        </>
      ) : (
        <>
          <div className="field-group">
            <label className="field-label">Current PIN</label>
            <input className="glass-input" type="password" value={current}
              onChange={(event) => setCurrent(event.target.value)} />
          </div>
          <div className="field-group">
            <label className="field-label">New PIN ({MIN_PIN_LENGTH}–{MAX_PIN_LENGTH} digits)</label>
            <input className="glass-input" type="password" inputMode="numeric" pattern="[0-9]*" value={next}
              maxLength={MAX_PIN_LENGTH}
              onChange={(event) => setNext(event.target.value)} />
          </div>
          {error && <p className="form-error">{error}</p>}
          <button className="btn-wood btn-block" disabled={!current || !isValidPin(next)} onClick={submit}>
            Change PIN
          </button>
          <button className="btn-ghost btn-block" onClick={onClose}>Cancel</button>
        </>
      )}
    </Modal>
  );
}

function WipeDevice({ onClose, onWiped }) {
  const [confirmation, setConfirmation] = useState("");
  return (
    <Modal title="Remove this device" onClose={onClose}>
      <p className="onboard-warning">
        This erases your account and all chat history from this device. Your account
        still exists — restore it anywhere with your twelve-word phrase. Messages that
        only ever lived here will be gone.
      </p>
      <p className="panel-note">Type <strong>REMOVE</strong> to confirm.</p>
      <input className="glass-input" value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)} />
      <button
        className="btn-danger btn-block"
        disabled={confirmation !== "REMOVE"}
        onClick={async () => {
          // Before the local database goes, hand back the push subscription.
          // Otherwise this device keeps buzzing with "message from @someone" for
          // an account it no longer holds, and the person removing it has no way
          // left to stop it.
          await disablePushAlerts().catch(() => {});
          await wipeDevice();
          onWiped("");
        }}
      >
        Erase this device
      </button>
      <button className="btn-ghost btn-block" onClick={onClose}>Cancel</button>
    </Modal>
  );
}
