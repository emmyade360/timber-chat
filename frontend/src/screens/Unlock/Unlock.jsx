// The lock screen.
//
// Unlocking derives the identity from the stored phrase and immediately signs a
// fresh challenge, so a session token never has to be persisted anywhere.

import { useState } from "react";
import { MAX_ATTEMPTS, VaultWipedError, attemptsRemaining, unlockVault, wipeDevice } from "../../crypto/vault.js";
import { openSession } from "../../crypto/session.js";
import { deriveIdentity } from "../../crypto/identity.js";
import { signIn } from "../../lib/auth.js";
import LevelBadge from "../../components/Level/LevelBadge.jsx";

export default function Unlock({ onUnlocked, onWiped }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState(MAX_ATTEMPTS);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!pin || busy) return;
    setBusy(true);
    setError("");
    try {
      const mnemonic = await unlockVault(pin);
      const identity = deriveIdentity(mnemonic);
      await signIn(identity);
      openSession(mnemonic);
      onUnlocked();
    } catch (caught) {
      if (caught instanceof VaultWipedError) {
        onWiped(caught.message);
        return;
      }
      setError(caught.message);
      setRemaining(await attemptsRemaining());
      setPin("");
    } finally {
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

  return (
    <div className="onboard-bg">
      <div className="onboard-card glass-panel unlock-card">
        <LevelBadge level={12} size={72} />
        <h1 className="onboard-brand">Timber</h1>
        <p className="onboard-tagline">welcome back</p>

        <div className="field-group">
          <label className="field-label">Enter your PIN</label>
          <input
            className="glass-input"
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            autoFocus
            autoComplete="current-password"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submit()}
          />
        </div>

        {error && <p className="form-error">{error}</p>}
        {remaining <= 3 && remaining > 0 && (
          <p className="onboard-warning">
            {remaining} {remaining === 1 ? "attempt" : "attempts"} left before this device is
            wiped. Your phrase will restore it.
          </p>
        )}

        <button className="btn-wood btn-block" disabled={!pin || busy} onClick={submit}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
        <button className="btn-ghost btn-block" onClick={forget}>
          Use a different account
        </button>
      </div>
    </div>
  );
}
