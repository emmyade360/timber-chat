// Backing up the phrase and choosing a PIN, after the fact.
//
// These three steps used to sit between a new visitor and their first message,
// which is a lot to ask of someone who has nothing yet to lose. They live here
// instead, and are offered once there is something worth protecting.
//
// The order is the invariant, not a preference: the phrase is what recovers a
// forgotten PIN, so a PIN may only be set in the same flow that backs the
// phrase up. `secureVaultWithPin` is reached through `confirm`, never directly.

import { useEffect, useId, useMemo, useState } from "react";
import GrowingTree from "../../components/Loader/GrowingTree.js";
import { useSlowWait } from "../../components/Loader/useSlowWait.js";
import { openDeviceVault, secureVaultWithPin } from "../../crypto/vault.js";
import { MAX_PIN_LENGTH, MIN_PASSPHRASE_LENGTH, MIN_PIN_LENGTH, isValidPin } from "../../crypto/vault.js";

const CONFIRM_COUNT = 3;

export default function SecureAccount({ onDone, onCancel }) {
  const [step, setStep] = useState("phrase");
  const [mnemonic, setMnemonic] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let ignore = false;
    openDeviceVault()
      .then((phrase) => { if (!ignore) setMnemonic(phrase); })
      .catch(() => {
        if (!ignore) setError("This account already has a PIN. Change it from Settings instead.");
      });
    return () => { ignore = true; };
  }, []);

  const finish = async (pin) => {
    setBusy(true);
    setError("");
    try {
      await secureVaultWithPin(pin);
      onDone?.();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  };

  if (!mnemonic && !error) {
    return <div className="onboard-bg"><div className="onboard-card glass-panel"><GrowingTree size={140} label="Opening your account…" /></div></div>;
  }

  return (
    <div className="onboard-bg">
      <div className="onboard-card glass-panel">
        {step === "phrase" && (
          <ShowPhrase
            mnemonic={mnemonic}
            onContinue={() => setStep("confirm")}
            onBack={onCancel}
          />
        )}
        {step === "confirm" && (
          <ConfirmPhrase
            mnemonic={mnemonic}
            onBack={() => setStep("phrase")}
            onConfirmed={() => setStep("pin")}
          />
        )}
        {step === "pin" && (
          <SetPin busy={busy} error={error} onBack={() => setStep("confirm")} onSubmit={finish} />
        )}
        {error && step === "phrase" && <p className="form-error">{error}</p>}
      </div>
    </div>
  );
}

export function ShowPhrase({ mnemonic, onContinue, onBack }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const words = mnemonic.split(" ");

  return (
    <>
      <h2 className="onboard-title">Your recovery phrase</h2>
      <p className="onboard-lede">
        Write these twelve words down in order and keep them somewhere safe. They are how
        you sign in on a new device, and how you set a new PIN if you ever forget yours.
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
        Nobody — including us — can recover these for you. Without them, a lost device is a
        lost account.
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
      {onBack && <button className="btn-ghost btn-block" onClick={onBack}>Not now</button>}
    </>
  );
}

export function ConfirmPhrase({ mnemonic, onConfirmed, onBack }) {
  const fieldId = useId();
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
          <label className="field-label" htmlFor={`${fieldId}-${index}`}>Word {index + 1}</label>
          <input
            id={`${fieldId}-${index}`}
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

export function SetPin({ onSubmit, onBack, busy, error, title = "Set a PIN", lede }) {
  const fieldId = useId();
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const mismatch = again.length > 0 && pin !== again;
  const slow = useSlowWait(busy);

  // Stretching the PIN is deliberately memory-hard and takes real time on a
  // phone, so the wait gets a picture and an explanation rather than a disabled
  // button and no news.
  if (busy) {
    return <GrowingTree size={168} label={slow ? "Still working…" : "Locking your grove…"} />;
  }

  return (
    <>
      <h2 className="onboard-title">{title}</h2>
      <p className="onboard-lede">
        {lede ?? "Your phrase is stored on this device, locked with this PIN. You will enter it when you come back, so you never have to type twelve words again."}
      </p>

      <div className="field-group">
        <label className="field-label" htmlFor={`${fieldId}-pin`}>
          PIN ({MIN_PIN_LENGTH}+ digits, or {MIN_PASSPHRASE_LENGTH}+ characters)
        </label>
        <input
          id={`${fieldId}-pin`}
          className="glass-input"
          type="password"
          inputMode="numeric"
          maxLength={MAX_PIN_LENGTH}
          autoComplete="new-password"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
        />
      </div>
      <div className="field-group">
        <label className="field-label" htmlFor={`${fieldId}-confirm`}>Confirm PIN</label>
        <input
          id={`${fieldId}-confirm`}
          className="glass-input"
          type="password"
          inputMode="numeric"
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
        Protect my account
      </button>
      {onBack && <button className="btn-ghost btn-block" onClick={onBack}>Back</button>}
    </>
  );
}
