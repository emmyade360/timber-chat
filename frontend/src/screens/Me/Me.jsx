// Settings: progression, privacy, notifications, device continuity, and account safety.

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useChatStore } from "../../store/chatStore.js";
import LevelBadge from "../../components/Level/LevelBadge.jsx";
import InvitePanel from "../../components/Invite/InvitePanel.jsx";
import { MAX_PIN_LENGTH, MIN_PIN_LENGTH, changePin, exportVaultTransfer, isValidPin, unlockVault, wipeDevice } from "../../crypto/vault.js";
import {
  clearDigest,
  notificationSettings,
  pendingDigestCount,
  requestNotificationPermission,
  updateNotificationSettings,
} from "../../lib/notifications.js";
import { callAlertsEnabled, disableCallAlerts, enableCallAlerts, pushSupported } from "../../lib/push.js";
import { getHealth } from "../../lib/api.js";

export default function Settings({ onBack, onOpenExplore, onOpenInstall, onSignOut, onWiped }) {
  const { me, ladder } = useChatStore();
  const [panel, setPanel] = useState(null);

  if (!me) return <div className="screen"><div className="empty-state">Loading…</div></div>;

  const span = me.growth_for_stage || 1;
  const percent = Math.min(100, Math.round((me.growth_into_stage / span) * 100));
  const atMax = !me.next_level_name;

  return (
    <div className="screen">
      <header className="screen-header">
        <button className="screen-header-action" onClick={onBack} aria-label="Back to profile">‹</button>
        <h1 className="screen-title">Settings</h1>
      </header>

      <section className="profile-hero">
        <LevelBadge level={me.level} size={104} />
        <h2 className="profile-name">@{me.username}</h2>
        <p className="profile-level">
          Growth stage {me.level} · {me.level_name}
        </p>

        <progress
          className="growth-bar"
          aria-label="Growth progress"
          value={atMax ? 100 : percent}
          max="100"
        />
        <p className="growth-caption">
          {atMax
            ? `${me.growth_points.toLocaleString()} growth points — your path is complete.`
            : `${me.growth_into_stage.toLocaleString()} / ${me.growth_for_stage.toLocaleString()} growth · ${me.growth_to_next.toLocaleString()} to ${me.next_level_name}`}
        </p>

        <div className="stat-row">
          <Stat label="Growth" value={me.growth_points.toLocaleString()} />
          <Stat label="Steady days" value={me.streak_days} />
          <Stat label="Stage" value={`${me.level}/21`} />
        </div>
      </section>

      <InvitePanel />

      <section className="panel">
        <h3 className="section-title">Privacy & discovery</h3>
        <p className="panel-note">Chats are private and encrypted. Explore is separate, opt-in public profile data for finding friends; it never uses device location or open DMs.</p>
        <button className="btn-ghost btn-block" onClick={onOpenExplore}>Manage Explore privacy</button>
      </section>

      <NotificationControls />
      <CallAlertControls />
      <section className="panel">
        <h3 className="section-title">Timber app</h3>
        <p className="panel-note">Install Timber for a focused full-screen experience. Installation never changes how your encrypted data is stored.</p>
        <button className="btn-ghost btn-block" onClick={onOpenInstall}>Install Timber</button>
      </section>
      <DeviceContinuity />

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
        <section className="panel">
          <h3 className="section-title">Your growth path</h3>
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
        </section>
      )}

      <section className="panel">
        <h3 className="section-title">Account & security</h3>
        <p className="panel-note">
          Timber has no password and no email. Your twelve-word phrase is the only way
          back in — keep it somewhere safe and never share it.
        </p>
        <button className="btn-ghost btn-block" onClick={() => setPanel("phrase")}>
          Show recovery phrase
        </button>
        <button className="btn-ghost btn-block" onClick={() => setPanel("pin")}>
          Change PIN
        </button>
        <button className="btn-ghost btn-block" onClick={onSignOut}>
          Lock Timber
        </button>
        <button className="btn-danger btn-block" onClick={() => setPanel("wipe")}>
          Remove this device
        </button>
      </section>

      <section className="panel">
        <h3 className="section-title">About</h3>
        <BuildInfo />
      </section>

      {panel === "phrase" && <RevealPhrase onClose={() => setPanel(null)} />}
      {panel === "pin" && <ChangePin onClose={() => setPanel(null)} />}
      {panel === "wipe" && <WipeDevice onClose={() => setPanel(null)} onWiped={onWiped} />}
    </div>
  );
}

/**
 * The version this device is running, and the one the relay is running.
 *
 * Worth a row of its own: the first useful question about any bug report is
 * which build the person is on, and an installed PWA can sit on a cached shell
 * for a while after a release.
 */
function BuildInfo() {
  const [server, setServer] = useState(null);
  useEffect(() => {
    let live = true;
    getHealth()
      .then(({ data }) => { if (live) setServer(data.version ?? "unknown"); })
      .catch(() => { if (live) setServer("unreachable"); });
    return () => { live = false; };
  }, []);

  return (
    <>
      <div className="settings-row">
        <div>
          <span className="settings-row-title">App</span>
          <span className="settings-row-note">This device</span>
        </div>
        <span className="settings-row-state">{__APP_VERSION__}</span>
      </div>
      <div className="settings-row">
        <div>
          <span className="settings-row-title">Relay</span>
          <span className="settings-row-note">Timber service</span>
        </div>
        <span className="settings-row-state">{server ?? "…"}</span>
      </div>
      <p className="panel-note">
        Quote the app version if you ever report a problem. It never identifies you.
      </p>
    </>
  );
}

function CallAlertControls() {
  const [enabled, setEnabled] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    callAlertsEnabled().then(setEnabled).catch(() => setEnabled(false));
  }, []);
  return <section className="panel">
    <h3 className="section-title">Incoming call alerts</h3>
    <p className="panel-note">Optional. When Timber is installed but closed, a browser notification can say who is calling. It never includes chat text.</p>
    {!pushSupported() ? <p className="panel-note">This browser does not support background call alerts.</p> : !enabled ? <button className="btn-ghost btn-block" onClick={async () => {
      try { await enableCallAlerts(); setEnabled(true); setNotice("Incoming call alerts are on for this device."); }
      catch (error) { setNotice(error.message || "Call alerts could not be enabled."); }
    }}>Enable incoming call alerts</button> : <button className="btn-ghost btn-block" onClick={async () => {
      await disableCallAlerts(); setEnabled(false); setNotice("Incoming call alerts are off for this device.");
    }}>Turn off incoming call alerts</button>}
    {notice && <p className="field-ok">{notice}</p>}
  </section>;
}

function DeviceContinuity() {
  const [transfer, setTransfer] = useState("");
  const [notice, setNotice] = useState("");
  return (
    <section className="panel">
      <h3 className="section-title">Restore & device continuity</h3>
      <p className="panel-note">{navigator.onLine ? "Sync is available: " : "You are offline: "} Timber restores encrypted ciphertext after you sign in on another device. The server cannot open it.</p>
      {!transfer ? <button className="btn-ghost btn-block" onClick={async () => {
        try { setTransfer(await exportVaultTransfer()); }
        catch { setNotice("Could not prepare the encrypted transfer code. Try again while Timber is unlocked."); }
      }}>Show encrypted transfer QR</button> : <>
        <div className="safety-qr" aria-label="Encrypted device transfer QR code"><QRCodeSVG value={transfer} size={176} includeMargin /></div>
        <p className="onboard-warning">This QR is an encrypted copy of your device vault, not your recovery phrase. Treat it like a password export: show it only to your new device, which must also enter this device’s current PIN.</p>
        <button className="btn-ghost btn-block" onClick={async () => {
          try { await navigator.clipboard.writeText(transfer); setNotice("Encrypted transfer code copied."); }
          catch { setNotice("Copy is unavailable in this browser; scan the QR on your new device."); }
        }}>Copy encrypted transfer code</button>
        <button className="btn-ghost btn-block" onClick={() => setTransfer("")}>Hide transfer code</button>
      </>}
      {notice && <p className="field-ok">{notice}</p>}
    </section>
  );
}

function NotificationControls() {
  const [settings, setSettings] = useState({ enabled: false, digest: false, checkIns: false });
  const [digestCount, setDigestCount] = useState(0);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        setSettings(await notificationSettings());
        setDigestCount(await pendingDigestCount());
      } catch { /* preferences are optional */ }
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const patch = async (next) => {
    const saved = await updateNotificationSettings(next);
    setSettings(saved);
  };

  return (
    <section className="panel">
      <h3 className="section-title">Calm notifications</h3>
      <p className="panel-note">Off by default. Notifications never include message text; each chat can also be muted from its header.</p>
      {!settings.enabled ? (
        <button className="btn-ghost btn-block" onClick={async () => {
          try { setSettings(await requestNotificationPermission()); setNotice("Private notifications are on."); }
          catch { setNotice("Notifications are unavailable or were not allowed by this browser."); }
        }}>Enable private notifications</button>
      ) : <>
        <label className="explore-check"><input type="checkbox" checked={settings.digest} onChange={(event) => patch({ digest: event.target.checked })} /> <span>Collect messages in a quiet digest instead of alerting immediately</span></label>
        <label className="explore-check"><input type="checkbox" checked={settings.checkIns} onChange={(event) => patch({ checkIns: event.target.checked })} /> <span>Optional generic check-in reminder while Timber is open</span></label>
        {digestCount > 0 && <button className="btn-ghost btn-block" onClick={async () => { await clearDigest(); setDigestCount(0); }}>Clear quiet digest ({digestCount})</button>}
      </>}
      {notice && <p className="field-ok">{notice}</p>}
    </section>
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

function Modal({ title, children, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal glass-panel" onClick={(event) => event.stopPropagation()}>
        <h3 className="modal-title">{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** Re-asks for the PIN: the phrase is the account, so showing it needs proof. */
function RevealPhrase({ onClose }) {
  const [pin, setPin] = useState("");
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState("");

  const reveal = async () => {
    try {
      setPhrase(await unlockVault(pin));
      setError("");
    } catch (caught) {
      setError(caught.message);
    }
  };

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
