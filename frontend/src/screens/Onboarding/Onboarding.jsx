// Account creation and recovery.
//
// The flow is deliberately slower than a signup form: the recovery phrase IS the
// account, and there is no reset link, no support inbox, and no way for us to help
// someone who loses it. The confirmation step exists to make that concrete before
// the user has anything to lose.

import { useEffect, useMemo, useState } from "react";
import { createMnemonic, deriveIdentity, isValidMnemonic, normalizeMnemonic, unknownWords } from "../../crypto/identity.js";
import { MAX_PIN_LENGTH, MIN_PIN_LENGTH, createVault, importVaultTransfer, isValidPin, unlockVault } from "../../crypto/vault.js";
import { openSession } from "../../crypto/session.js";
import { hasAccount, register, signIn } from "../../lib/auth.js";
import { checkUsername, inviteCodeFromUrl, lookupInvite } from "../../lib/api.js";
import LevelBadge from "../../components/Level/LevelBadge.jsx";

const CONFIRM_COUNT = 3;

export default function Onboarding({ onReady }) {
  const [step, setStep] = useState("welcome");
  const [mnemonic, setMnemonic] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Present when the visitor arrived through someone's invite link.
  const [inviteCode] = useState(() => inviteCodeFromUrl());
  const [inviter, setInviter] = useState(null);

  useEffect(() => {
    if (!inviteCode) return;
    lookupInvite(inviteCode)
      .then(({ data }) => setInviter(data.valid ? data : null))
      .catch(() => setInviter(null));
  }, [inviteCode]);

  // Set when this flow is creating a new account, empty when restoring one. It is
  // what tells the final step whether to register or simply sign in.
  const isNewAccount = username !== "";

  const restart = () => {
    setMnemonic("");
    setUsername("");
    setError("");
    setStep("welcome");
  };

  const finish = async (pin) => {
    setBusy(true);
    setError("");
    try {
      const identity = deriveIdentity(mnemonic);
      if (isNewAccount) await register(identity, username, inviteCode);
      else await signIn(identity);

      // The vault is written only after the server round trip succeeds, so a
      // failed signup cannot leave a half-created account locked on the device.
      await createVault(mnemonic, pin);
      openSession(mnemonic);
      onReady({ newAccount: isNewAccount });
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (phrase) => {
    setBusy(true);
    setError("");
    try {
      const identity = deriveIdentity(phrase);
      if (!(await hasAccount(identity))) {
        setError("That phrase is valid, but has no Timber account yet. Create one instead.");
        return;
      }
      setMnemonic(normalizeMnemonic(phrase));
      setStep("pin");
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onboard-bg">
      <div className="wood-grain-overlay" />
      <div className="onboard-card glass-panel">
        {inviter && step === "welcome" && (
          <div className="invite-banner">
            <LevelBadge level={inviter.level} size={38} />
            <span>
              <strong>@{inviter.username}</strong> invited you to Timber.
              <span className="invite-banner-sub">
                Join and you both earn XP — they get {"1,000"}, you start with {inviter.welcome_xp}.
              </span>
            </span>
          </div>
        )}

        {step === "welcome" && (
          <Welcome
            onCreate={() => {
              setMnemonic(createMnemonic());
              setStep("phrase");
            }}
            onImport={() => setStep("import")}
            onTransfer={() => setStep("transfer")}
          />
        )}

        {step === "phrase" && (
          <ShowPhrase mnemonic={mnemonic} onContinue={() => setStep("confirm")} onBack={restart} />
        )}

        {step === "confirm" && (
          <ConfirmPhrase
            mnemonic={mnemonic}
            onBack={() => setStep("phrase")}
            onConfirmed={() => setStep("username")}
          />
        )}

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
                openSession(phrase);
                onReady({ newAccount: false });
              } catch (caught) {
                setError(caught.message);
              } finally {
                setBusy(false);
              }
            }}
          />
        )}

        {step === "username" && (
          <ClaimUsername
            onBack={() => setStep("confirm")}
            onClaimed={(claimed) => {
              setUsername(claimed);
              setStep("pin");
            }}
          />
        )}

        {step === "pin" && (
          <SetPin
            busy={busy}
            error={error}
            onBack={() => setStep(isNewAccount ? "username" : "import")}
            onSubmit={finish}
          />
        )}
      </div>
    </div>
  );
}

function Welcome({ onCreate, onImport, onTransfer }) {
  return (
    <>
      <Logo />
      <p className="onboard-lede">
        Your account is a phrase of twelve words. It lives on your device, never on our
        servers, and it is the only key to your conversations.
      </p>
      <button className="btn-wood btn-block" onClick={onCreate}>
        Create a new account
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
      <div className="field-group"><label className="field-label">Current device PIN</label><input className="glass-input" type="password" inputMode="numeric" pattern="[0-9]*" value={pin} onChange={(event) => setPin(event.target.value)} /></div>
      {error && <p className="form-error">{error}</p>}
      <button className="btn-wood btn-block" disabled={!transfer.trim() || !pin || busy} onClick={() => onSubmit(transfer, pin)}>{busy ? "Transferring…" : "Transfer securely"}</button>
      <button className="btn-ghost btn-block" onClick={onBack}>Back</button>
    </>
  );
}

function ShowPhrase({ mnemonic, onContinue, onBack }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const words = mnemonic.split(" ");

  return (
    <>
      <h2 className="onboard-title">Your recovery phrase</h2>
      <p className="onboard-lede">
        Write these twelve words down in order and keep them somewhere safe.
      </p>

      <ol className="phrase-grid">
        {words.map((word, index) => (
          <li key={`${word}-${index}`} className="phrase-word">
            <span className="phrase-index">{index + 1}</span>
            {word}
          </li>
        ))}
      </ol>

      <p className="onboard-warning">
        There is no password reset. Nobody — including us — can recover this for you.
        If you lose these words, you lose the account and every conversation in it.
      </p>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <span>I have written my phrase down</span>
      </label>

      <button className="btn-wood btn-block" disabled={!acknowledged} onClick={onContinue}>
        Continue
      </button>
      <button className="btn-ghost btn-block" onClick={onBack}>
        Back
      </button>
    </>
  );
}

function ConfirmPhrase({ mnemonic, onConfirmed, onBack }) {
  const words = useMemo(() => mnemonic.split(" "), [mnemonic]);
  // Ask for a few positions at random rather than the whole phrase: enough to
  // prove it was written down, short enough that people actually do it.
  // A lazy useState initialiser runs exactly once, so the questions cannot
  // reshuffle underneath the user on a re-render.
  const [asked] = useState(() => {
    const indexes = new Set();
    const draw = new Uint8Array(1);
    while (indexes.size < CONFIRM_COUNT) {
      crypto.getRandomValues(draw);
      // Reject values in the biased tail rather than folding them with a modulo.
      const limit = 256 - (256 % words.length);
      if (draw[0] < limit) indexes.add(draw[0] % words.length);
    }
    return [...indexes].sort((a, b) => a - b);
  });

  const [answers, setAnswers] = useState({});
  const [error, setError] = useState("");

  const check = () => {
    const wrong = asked.filter(
      (index) => (answers[index] ?? "").trim().toLowerCase() !== words[index],
    );
    if (wrong.length) {
      setError(`Word ${wrong.map((index) => index + 1).join(", ")} does not match.`);
      return;
    }
    onConfirmed();
  };

  return (
    <>
      <h2 className="onboard-title">Confirm your phrase</h2>
      <p className="onboard-lede">Type these words from the phrase you just saved.</p>

      {asked.map((index) => (
        <div className="field-group" key={index}>
          <label className="field-label">Word {index + 1}</label>
          <input
            className="glass-input"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck="false"
            value={answers[index] ?? ""}
            onChange={(event) =>
              setAnswers((current) => ({ ...current, [index]: event.target.value }))
            }
          />
        </div>
      ))}

      {error && <p className="form-error">{error}</p>}
      <button className="btn-wood btn-block" onClick={check}>
        Confirm
      </button>
      <button className="btn-ghost btn-block" onClick={onBack}>
        Show me the phrase again
      </button>
    </>
  );
}

function ImportPhrase({ onSubmit, onBack, busy, error }) {
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
        {busy ? "Checking…" : "Restore"}
      </button>
      <button className="btn-ghost btn-block" onClick={onBack}>
        Back
      </button>
    </>
  );
}

function ClaimUsername({ onClaimed, onBack }) {
  const [username, setUsername] = useState("");
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);

  const verify = async (value) => {
    setUsername(value);
    setStatus(null);
    if (value.trim().length < 3) return;
    setChecking(true);
    try {
      const { data } = await checkUsername(value.trim());
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <h2 className="onboard-title">Choose your username</h2>
      <p className="onboard-lede">
        This is how friends find you. It is claimed once and cannot be changed.
      </p>

      <div className="field-group">
        <label className="field-label">Username</label>
        <div className="username-field">
          <span className="username-at">@</span>
          <input
            className="glass-input"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck="false"
            placeholder="your_name"
            value={username}
            onChange={(event) => verify(event.target.value)}
          />
        </div>
        {checking && <p className="field-hint">Checking…</p>}
        {status?.available === true && <p className="field-ok">@{status.username} is available</p>}
        {status?.available === false && <p className="form-error">{status.reason}</p>}
      </div>

      <button
        className="btn-wood btn-block"
        disabled={!status?.available}
        onClick={() => onClaimed(status.username)}
      >
        Claim it
      </button>
      <button className="btn-ghost btn-block" onClick={onBack}>
        Back
      </button>
    </>
  );
}

function SetPin({ onSubmit, onBack, busy, error }) {
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const mismatch = again.length > 0 && pin !== again;

  return (
    <>
      <h2 className="onboard-title">Set a PIN</h2>
      <p className="onboard-lede">
        Your phrase is stored on this device, locked with this PIN. You will enter it
        each time you open Timber, so you never have to type twelve words again.
      </p>

      <div className="field-group">
        <label className="field-label">PIN ({MIN_PIN_LENGTH}–{MAX_PIN_LENGTH} digits)</label>
        <input
          className="glass-input"
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={MAX_PIN_LENGTH}
          autoComplete="new-password"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
        />
      </div>
      <div className="field-group">
        <label className="field-label">Confirm PIN</label>
        <input
          className="glass-input"
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={MAX_PIN_LENGTH}
          autoComplete="new-password"
          value={again}
          onChange={(event) => setAgain(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && isValidPin(pin) && pin === again) onSubmit(pin);
          }}
        />
      </div>

      {mismatch && <p className="form-error">Those PINs do not match.</p>}
      {error && <p className="form-error">{error}</p>}

      <button
        className="btn-wood btn-block"
        disabled={!isValidPin(pin) || pin !== again || busy}
        onClick={() => onSubmit(pin)}
      >
        {busy ? "Setting up…" : "Enter the Grove"}
      </button>
      <button className="btn-ghost btn-block" onClick={onBack}>
        Back
      </button>
    </>
  );
}

function Logo() {
  return (
    <div className="onboard-logo">
      <span className="onboard-logo-icon">🪵</span>
      <h1 className="onboard-brand">Timber</h1>
      <p className="onboard-tagline">where conversations grow</p>
    </div>
  );
}
