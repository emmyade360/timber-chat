// The unlocked session: the only place a live secret key exists.
//
// Held in a module-level variable rather than React state on purpose -- it must
// never be serialised into a store, a devtools snapshot, or a server render.
// Locking wipes the key bytes in place, so anything still holding a reference
// sees zeroes rather than usable key material.

import { deriveIdentity } from "./identity.js";
import { forgetConversationKeys } from "./envelope.js";

let identity = null;
const listeners = new Set();

function notify() {
  for (const listener of listeners) listener(identity !== null);
}

/** Derive and hold the identity for an unlocked phrase. */
export function openSession(mnemonic) {
  closeSession();
  identity = deriveIdentity(mnemonic);
  notify();
  return identity;
}

/** The unlocked identity, or null when locked. */
export function peekIdentity() {
  return identity;
}

/** The unlocked identity. Throws when locked, so callers cannot silently no-op. */
export function currentIdentity() {
  if (!identity) throw new Error("The app is locked.");
  return identity;
}

export function isUnlocked() {
  return identity !== null;
}

/** Lock: wipe every derived secret and drop cached conversation keys. */
export function closeSession() {
  if (identity) {
    identity.identitySk.fill(0);
    identity.kexSk.fill(0);
    identity.localDbKey.fill(0);
    identity = null;
  }
  forgetConversationKeys();
  notify();
}

/** Subscribe to lock/unlock transitions. Returns an unsubscribe function. */
export function onSessionChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
