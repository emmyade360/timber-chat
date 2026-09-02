// The nudge that replaces the signup ritual.
//
// Nothing here gates anything. It appears once there is a real conversation to
// lose, states what is actually at stake, and can be put off -- which is the
// whole trade the deferred phrase makes: the account is safe to ignore until
// the person has a reason to care about it.

import { useEffect, useState } from "react";
import { isVaultSecured } from "../../crypto/vault.js";

const SNOOZE_KEY = "timber-secure-prompt-snoozed";
const SNOOZE_MS = 24 * 60 * 60 * 1000;

function snoozedUntil() {
  try {
    const value = Number(localStorage.getItem(SNOOZE_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function snooze() {
  try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch { /* optional */ }
}

export default function SecurePrompt({ conversationCount = 0, onStart }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let ignore = false;
    // Nothing to protect yet, or recently put off.
    if (conversationCount < 1 || Date.now() < snoozedUntil()) return undefined;
    isVaultSecured()
      .then((secured) => { if (!ignore) setShow(!secured); })
      .catch(() => {});
    return () => { ignore = true; };
  }, [conversationCount]);

  if (!show) return null;

  return (
    <section className="secure-prompt glass-panel">
      <span className="secure-prompt-mark" aria-hidden="true">⚿</span>
      <div className="secure-prompt-copy">
        <strong>Back up your account</strong>
        <small>
          Your conversations live on this device. Save your twelve words so a lost phone is
          not a lost account.
        </small>
      </div>
      <div className="secure-prompt-actions">
        <button className="btn-wood btn-sm" onClick={onStart}>Back up</button>
        <button
          className="btn-ghost btn-sm"
          onClick={() => { snooze(); setShow(false); }}
        >
          Later
        </button>
      </div>
    </section>
  );
}
