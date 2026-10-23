// The lock screen.
//
// Unlocking derives the identity from the stored phrase and immediately signs a
// fresh challenge, so a session token never has to be persisted anywhere.
//
// It also knows whose device this is. That is plaintext beside the sealed vault
// rather than inside it, because there is no key to read anything with until
// the PIN has already been entered -- see VaultIdentity in types/db.ts for the
// trade that makes, and Settings for the switch that turns it off.

import { useEffect, useState } from "react";
import {
  PhraseMismatchError,
  VaultLockedError,
  VaultWipedError,
  WrongPinError,
  attemptsRemaining,
  resetPinWithPhrase,
  unlockVault,
  vaultIdentity,
  wipeDevice,
} from "../../crypto/vault.js";
import { deriveIdentity, isValidMnemonic, normalizeMnemonic, unknownWords } from "../../crypto/identity.js";
import { beginSession } from "../../lib/lockSession.js";
import { signIn } from "../../lib/auth.js";
import { startSessionRecovery } from "../../lib/sessionRecovery.js";
import { SetPin } from "../Secure/SecureAccount.jsx";
import LevelBadge from "../../components/Level/LevelBadge.jsx";

export default function Unlock({ onUnlocked, onWiped }) {
  const [mode, setMode] = useState("pin");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState(null);
  const [busy, setBusy] = useState(false);
  const [owner, setOwner] = useState(null);
  const [phrase, setPhrase] = useState("");

  useEffect(() => {
    let ignore = false;
    vaultIdentity()
      .then((identity) => { if (!ignore) setOwner(identity); })
      .catch(() => {});
    attemptsRemaining()
      .then((left) => { if (!ignore) setRemaining(left); })
      .catch(() => {});
    return () => { ignore = true; };
  }, []);

  /** Shared tail of every way into the app: open the session, then sign in behind it. */
  const enter = async (mnemonic) => {
    const identity = deriveIdentity(mnemonic);
    await beginSession(mnemonic);
    onUnlocked();
    // Behind the app, not in front of it. `startSessionRecovery` keeps trying
    // if the relay is still waking, so opening offline is a delay rather than
    // a dead end -- the same tolerance `restoreSession` has always had.
    signIn(identity).catch(() => { startSessionRecovery(); });
  };

  const submit = async () => {
    if (!pin || busy) return;
    setBusy(true);
    setError("");
    try {
      // Everything that decides whether this person may read their own history
      // is local: the PIN opens the vault, the phrase derives the keys. So the
      // session is opened and the app entered before the relay is contacted at
      // all. Waiting on the network here meant a suspended free-tier instance
      // could lock someone out of messages already decrypted on this device.
      await enter(await unlockVault(pin));
    } catch (caught) {
      if (caught instanceof VaultWipedError) {
        onWiped(caught.message);
        return;
      }
      setError(caught.message);
      setRemaining(await attemptsRemaining().catch(() => null));
      // Only a wrong PIN should cost the user their typing. Clearing the field
      // for every failure meant a transport error made them start over.
      if (caught instanceof WrongPinError) setPin("");
      if (caught instanceof VaultLockedError) setMode("recover");
    } finally {
      setBusy(false);
    }
  };

  const resetPin = async (nextPin) => {
    setBusy(true);
    setError("");
    try {
      const normalized = normalizeMnemonic(phrase);
      await resetPinWithPhrase(normalized, nextPin);
      await enter(normalized);
    } catch (caught) {
      setError(caught instanceof PhraseMismatchError ? caught.message : caught.message);
      setBusy(false);
    }
  };

  const forget = async () => {
    if (!window.confirm(
      "This removes the account and all chat history from this device. You can restore it with your twelve-word phrase. Continue?",
    )) return;
    await wipeDevice();
    onWiped("");
  };

  if (mode === "recover") {
    return (
      <div className="onboard-bg">
        <div className="onboard-card glass-panel unlock-card">
          <RecoverWithPhrase
            phrase={phrase}
            onPhraseChange={setPhrase}
            busy={busy}
            error={error}
            onSubmit={resetPin}
            onBack={() => { setMode("pin"); setPhrase(""); setError(""); }}
          />
        </div>
      </div>
    );
  }

  const locked = remaining === 0;

  return (
    <div className="onboard-bg">
      <div className="onboard-card glass-panel unlock-card">
        <Owner owner={owner} />

        {locked ? (
          <p className="onboard-warning">
            Too many incorrect attempts. Your twelve-word phrase will set a new PIN — nothing
            has been deleted.
          </p>
        ) : (
          <div className="field-group">
            <label className="field-label" htmlFor="unlock-pin">Enter your PIN</label>
            <input
              id="unlock-pin"
              className="glass-input"
              type="password"
              inputMode="numeric"
              autoFocus
              autoComplete="current-password"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && submit()}
            />
          </div>
        )}

        {error && <p className="form-error">{error}</p>}
        {!locked && remaining !== null && remaining <= 3 && remaining > 0 && (
          <p className="onboard-warning">
            {remaining} {remaining === 1 ? "attempt" : "attempts"} left before the PIN stops
            being accepted. Your phrase will set a new one.
          </p>
        )}

        {!locked && (
          <button className="btn-wood btn-block" disabled={!pin || busy} onClick={submit}>
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        )}
        <button className="btn-ghost btn-block" onClick={() => { setMode("recover"); setError(""); }}>
          Forgot your PIN?
        </button>
        <button className="btn-ghost btn-block" onClick={forget}>
          Use a different account
        </button>
      </div>
    </div>
  );
}

/**
 * Who this device belongs to, or the anonymous card when nothing is stored --
 * which is what an older vault, or someone who turned recognition off, gets.
 */
function Owner({ owner }) {
  if (!owner?.username) {
    return (
      <>
        <LevelBadge level={owner?.level ?? 1} size={72} />
        <h1 className="onboard-brand">Timber</h1>
        <p className="onboard-tagline">welcome back</p>
      </>
    );
  }
  return (
    <>
      {owner.avatarUrl
        ? <img className="profile-avatar profile-avatar--large" src={owner.avatarUrl} alt="" referrerPolicy="no-referrer" />
        : <LevelBadge level={owner.level ?? 1} size={72} name={owner.levelName} />}
      <h1 className="onboard-brand">@{owner.username}</h1>
      <p className="onboard-tagline">{owner.levelName ? `${owner.levelName} · welcome back` : "welcome back"}</p>
    </>
  );
}

/**
 * Setting a new PIN from the phrase.
 *
 * Nothing is erased on this path. The local database key comes from the seed
 * rather than from the PIN, so every message already on this device is still
 * readable once the new PIN is in place.
 */
function RecoverWithPhrase({ phrase, onPhraseChange, busy, error, onSubmit, onBack }) {
  const [stage, setStage] = useState("phrase");
  const unknown = phrase.trim() ? unknownWords(phrase) : [];
  const complete = normalizeMnemonic(phrase).split(" ").filter(Boolean).length === 12;
  const valid = complete && isValidMnemonic(phrase);

  if (stage === "pin") {
    return (
      <SetPin
        busy={busy}
        error={error}
        title="Choose a new PIN"
        lede="Your conversations on this device stay exactly where they are."
        onSubmit={onSubmit}
        onBack={() => setStage("phrase")}
      />
    );
  }

  return (
    <>
      <h2 className="onboard-title">Reset your PIN</h2>
      <p className="onboard-lede">
        Enter your twelve words to set a new PIN. Your messages on this device are not
        deleted.
      </p>

      <textarea
        className="glass-input phrase-input"
        rows={4}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck="false"
        placeholder="oak sprout cedar ..."
        value={phrase}
        onChange={(event) => onPhraseChange(event.target.value)}
      />

      {unknown.length > 0 && <p className="form-error">Not valid words: {unknown.join(", ")}</p>}
      {unknown.length === 0 && complete && !valid && (
        <p className="form-error">
          Those are all real words, but the phrase checksum does not match. Check the order.
        </p>
      )}
      {error && <p className="form-error">{error}</p>}

      <button className="btn-wood btn-block" disabled={!valid || busy} onClick={() => setStage("pin")}>
        Continue
      </button>
      <button className="btn-ghost btn-block" onClick={onBack}>Back</button>
    </>
  );
}
