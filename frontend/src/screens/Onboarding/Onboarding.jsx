// Account creation and recovery.
//
// The recovery phrase is generated here but is deliberately not shown here.
// Nothing exists yet to protect, and putting twelve words and an unrecoverable
// warning in front of someone before their first message is the single most
// expensive screen in the product. The phrase is offered later, from
// screens/Secure/SecureAccount.jsx, once there is a conversation worth keeping.
//
// Both signup paths stage device-sealed keys before making an account online.
// Device storage is still essential: deleting it can remove account access.

import { useEffect, useMemo, useRef, useState } from "react";
import GrowingTree from "../../components/Loader/GrowingTree.js";
import { useSlowWait } from "../../components/Loader/useSlowWait.js";
import { WAKING_MESSAGE } from "../../lib/api.js";
import { createMnemonic, deriveIdentity, isValidMnemonic, normalizeMnemonic, unknownWords } from "../../crypto/identity.js";
import { createDeviceVault, importVaultTransfer, unlockVault } from "../../crypto/vault.js";
import { beginSession } from "../../lib/lockSession.js";
import { hasAccount, signIn } from "../../lib/auth.js";
import { pendingRegistration } from "../../crypto/registration.js";
import { completeRegistration } from "../../lib/registration.js";
import { inviteCodeFromUrl, lookupInvite } from "../../lib/api.js";
import LevelBadge from "../../components/Level/LevelBadge.jsx";
import TogetherMark from "../../components/Together/TogetherMark.jsx";
import { Icons } from "../../components/Settings/icons.jsx";

export default function Onboarding({ onReady }) {
  const [step, setStep] = useState("welcome");
  const [draft, setDraft] = useState(null);
  const [initializing, setInitializing] = useState(true);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Present when the visitor arrived through someone's invite link.
  const [inviteCode] = useState(() => inviteCodeFromUrl());
  const [inviter, setInviter] = useState(null);

  useEffect(() => {
    let live = true;
    pendingRegistration().then((pending) => {
      if (!live) return;
      if (pending) { setDraft(pending); setStep("username"); }
    }).catch(() => {
      if (live) setError("Could not read this device’s account storage. Keep its browser data and try reopening Timber.");
    }).finally(() => { if (live) setInitializing(false); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!inviteCode) return undefined;
    // Ignore a lookup that resolves after the code changed or the step moved on.
    let ignore = false;
    lookupInvite(inviteCode)
      .then(({ data }) => { if (!ignore) setInviter(data.valid ? data : null); })
      .catch(() => { if (!ignore) setInviter(null); });
    return () => { ignore = true; };
  }, [inviteCode]);

  const restart = () => {
    setError("");
    setStep("welcome");
  };

  const startSignup = async (isAnonymous) => {
    setError("");
    try {
      const pending = await pendingRegistration();
      setDraft(pending ?? { mnemonic: createMnemonic(), username: "", isAnonymous, inviteCode });
      setStep("username");
    } catch {
      setError("This browser cannot save an account securely. Enable site storage and try again.");
    }
  };

  /**
   * Claim the username and go straight in.
   *
   * A pending encrypted identity survives failures and is only promoted to the
   * active vault once the matching server account is confirmed.
   */
  const create = async (username) => {
    if (!draft || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await completeRegistration({ ...draft, username });
      await beginSession(result.mnemonic);
      onReady({ newAccount: result.created });
    } catch (caught) {
      setError(caught.message);
      const pending = await pendingRegistration().catch(() => null);
      if (pending) setDraft(pending);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  /**
   * Restore an existing account from its phrase.
   *
   * Someone who has just typed twelve words has demonstrably kept them, so they
   * are not asked to set a PIN before getting in either; Settings offers one.
   */
  const restore = async (phrase) => {
    setBusy(true);
    setError("");
    try {
      if (await pendingRegistration()) throw new Error("Finish this device’s pending signup before restoring another account.");
      const normalized = normalizeMnemonic(phrase);
      const identity = deriveIdentity(normalized);
      if (!(await hasAccount(identity))) {
        setError("That phrase is valid, but has no Timber account yet. Create one instead.");
        setBusy(false);
        return;
      }
      const account = await signIn(identity);
      await createDeviceVault(normalized, { userId: identity.userId, username: account.username }, account.is_anonymous);
      await beginSession(normalized);
      onReady({ newAccount: false });
    } catch (caught) {
      setError(caught.message);
      setBusy(false);
    }
  };

  return (
    <div className="onboard-bg">
      <div className="onboard-card glass-panel">
        {initializing && <GrowingTree size={140} label="Opening Timber…" />}
        {inviter && step === "welcome" && (
          <div className="invite-banner">
            <LevelBadge level={inviter.level} size={38} />
            <span>
              <strong>@{inviter.username}</strong> invited you to Timber.
              <span className="invite-banner-sub">
                Joining starts a private connection.
              </span>
            </span>
          </div>
        )}

        {!initializing && step === "welcome" && (
          <Welcome
            onCreate={() => startSignup(false)}
            onAnonymous={() => startSignup(true)}
            onImport={() => setStep("import")}
            onTransfer={() => setStep("transfer")}
          />
        )}

        {!initializing && step === "username" && draft && (
          <ClaimUsername busy={busy} error={error} onBack={restart} onClaimed={create}
            username={draft.username} isAnonymous={draft.isAnonymous}
            onUsernameChange={(username) => setDraft((current) => ({ ...current, username }))} />
        )}

        {!initializing && step === "welcome" && error && <p className="form-error" role="alert">{error}</p>}

        {step === "import" && (
          <ImportPhrase busy={busy} error={error} onBack={restart} onSubmit={restore} />
        )}

        {step === "transfer" && (
          <ImportTransfer
            busy={busy}
            error={error}
            onBack={restart}
            onSubmit={async (transfer, pin) => {
              setBusy(true);
              setError("");
              try {
                await importVaultTransfer(transfer);
                const phrase = await unlockVault(pin);
                const identity = deriveIdentity(phrase);
                await signIn(identity);
                await beginSession(phrase);
                onReady({ newAccount: false });
              } catch (caught) {
                setError(caught.message);
                setBusy(false);
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

function Welcome({ onCreate, onAnonymous, onImport, onTransfer }) {
  return (
    <>
      <Logo tagline={false} />
      <TogetherMark />
      <p className="onboard-lede">
        Private, end-to-end encrypted conversations. No phone number, no email, no password —
        your account belongs to this device and to nobody else.
      </p>
      <button className="btn-wood btn-block" onClick={onCreate}>
        Create a new account
      </button>
      <button className="btn-ghost btn-block anonymous-entry" onClick={onAnonymous}>
        <span aria-hidden="true">{Icons.shield}</span>
        <span><strong>Continue anonymously</strong><small>Choose a username · saved on this device · no usage analytics</small></span>
      </button>
      <button className="btn-ghost btn-block" onClick={onImport}>
        I already have a recovery phrase
      </button>
      <button className="btn-ghost btn-block" onClick={onTransfer}>
        Transfer from another device
      </button>
    </>
  );
}

function ImportTransfer({ onSubmit, onBack, busy, error }) {
  const [transfer, setTransfer] = useState("");
  const [pin, setPin] = useState("");
  return (
    <>
      <h2 className="onboard-title">Private device transfer</h2>
      <p className="onboard-lede">Scan or paste the encrypted transfer code shown on your existing Timber device. It never contains your twelve words in plaintext; unlock it with that device’s current PIN.</p>
      <textarea className="glass-input phrase-input" rows={5} autoComplete="off" spellCheck="false" placeholder="timber-vault/v1:…" value={transfer} onChange={(event) => setTransfer(event.target.value)} />
      <div className="field-group"><label className="field-label" htmlFor="transfer-pin">Current device PIN</label><input id="transfer-pin" className="glass-input" type="password" inputMode="numeric" value={pin} onChange={(event) => setPin(event.target.value)} /></div>
      {error && <p className="form-error">{error}</p>}
      <button className="btn-wood btn-block" disabled={!transfer.trim() || !pin || busy} onClick={() => onSubmit(transfer, pin)}>{busy ? "Transferring…" : "Transfer securely"}</button>
      <button className="btn-ghost btn-block" onClick={onBack}>Back</button>
    </>
  );
}

function ImportPhrase({ onSubmit, onBack, busy, error }) {
  const slow = useSlowWait(busy);
  const [phrase, setPhrase] = useState("");
  const unknown = useMemo(() => (phrase.trim() ? unknownWords(phrase) : []), [phrase]);
  const complete = normalizeMnemonic(phrase).split(" ").filter(Boolean).length === 12;
  const valid = complete && isValidMnemonic(phrase);

  return (
    <>
      <h2 className="onboard-title">Restore your account</h2>
      <p className="onboard-lede">Enter your twelve words, separated by spaces.</p>

      <textarea
        className="glass-input phrase-input"
        rows={4}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck="false"
        placeholder="oak sprout cedar ..."
        value={phrase}
        onChange={(event) => setPhrase(event.target.value)}
      />

      {/* Point at the specific bad word rather than rejecting the whole phrase. */}
      {unknown.length > 0 && (
        <p className="form-error">Not valid words: {unknown.join(", ")}</p>
      )}
      {unknown.length === 0 && complete && !valid && (
        <p className="form-error">
          Those are all real words, but the phrase checksum does not match. Check the order.
        </p>
      )}
      {error && <p className="form-error">{error}</p>}

      <button className="btn-wood btn-block" disabled={!valid || busy} onClick={() => onSubmit(phrase)}>
        {busy ? (slow ? "Still waking…" : "Checking…") : "Restore"}
      </button>
      <button className="btn-ghost btn-block" onClick={onBack}>
        Back
      </button>
    </>
  );
}

/**
 * The last step before the app.
 *
 * Claiming the username is the one thing here that genuinely cannot happen
 * offline, and it is the first request to touch a relay that may have been
 * asleep -- so this is where the wait gets a picture and an explanation.
 */
function ClaimUsername({ onClaimed, onBack, busy, error, username, onUsernameChange, isAnonymous }) {
  const slow = useSlowWait(busy);
  const normalized = username.trim().toLowerCase();
  const valid = /^[a-z0-9_]{3,20}$/.test(normalized);

  if (busy) {
    return <GrowingTree size={168} label={slow ? WAKING_MESSAGE : isAnonymous ? "Saving your anonymous account…" : "Planting your grove…"} />;
  }

  return (
    <>
      <h2 className="onboard-title">{isAnonymous ? "Your anonymous username" : "Choose your username"}</h2>
      <p className="onboard-lede">
        {isAnonymous ? "Choose a username so friends can find you. Your account is saved on this device. No email or phone number required."
          : "This is how friends find you. It is claimed once and cannot be changed."}
      </p>
      {isAnonymous && <div className="anonymous-signup-note">
        <span aria-hidden="true">{Icons.shield}</span>
        <div><strong>Your alias. Your device.</strong>
          <p>Optional usage analytics are off. Clearing browser data or losing this device can remove access to your account.</p>
          <small>Your username is permanent. Choose an alias that does not identify you.</small>
        </div>
      </div>}

      <div className="field-group">
        <label className="field-label" htmlFor="claim-username">Username</label>
        <div className="username-field">
          <span className="username-at">@</span>
          <input
            id="claim-username"
            className="glass-input"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck="false"
            placeholder="your_name"
            autoFocus
            value={username}
            onChange={(event) => onUsernameChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && valid) onClaimed(normalized); }}
          />
        </div>
        {username && !valid && <p className="form-error">Use 3–20 lowercase letters, numbers, or underscores.</p>}
      </div>

      {error && <p className="form-error">{error}</p>}

      <button className="btn-wood btn-block" disabled={!valid} onClick={() => onClaimed(normalized)}>
        {isAnonymous ? "Create anonymous account" : "Enter the Grove"}
      </button>
      <button className="btn-ghost btn-block" onClick={onBack}>
        Back
      </button>
    </>
  );
}

function Logo({ tagline = true }) {
  return (
    <div className="onboard-logo">
      <h1 className="onboard-brand">Timber</h1>
      {tagline && <p className="onboard-tagline">where conversations grow</p>}
    </div>
  );
}
