// The unlocked session: the only place a live secret key exists.
//
// Held in a module-level variable rather than React state on purpose -- it must
// never be serialised into a store, a devtools snapshot, or a server render.
// Locking wipes the key bytes in place, so anything still holding a reference
// sees zeroes rather than usable key material.

import { identityFromSeed, mnemonicSeed } from "./identity.js";
import type { Identity } from "../types/crypto.js";
import { forgetConversationKeys } from "./envelope.js";

let identity: Identity | null = null;
// The seed is kept beside the keys it produced, for two reasons: re-sealing the
// resume token when the auto-lock policy changes mid-session, and replaying the
// derivation after a reload. It is no more sensitive than the keys already here,
// and it is wiped by the same closeSession that wipes them.
let seed: Uint8Array | null = null;
let openedAt = 0;
const listeners = new Set<(unlocked: boolean) => void>();

function notify() {
  for (const listener of listeners) listener(identity !== null);
}

function adopt(nextSeed: Uint8Array, startedAt: number): Identity {
  closeSession();
  seed = nextSeed;
  identity = identityFromSeed(seed);
  openedAt = startedAt;
  notify();
  return identity;
}

/** Derive and hold the identity for an unlocked phrase. */
export function openSession(mnemonic: string, startedAt: number = Date.now()): Identity {
  return adopt(mnemonicSeed(mnemonic), startedAt);
}

/**
 * Re-open a session from a sealed seed, keeping the moment the PIN was actually
 * entered. Reusing the original timestamp is what stops a reload from silently
 * renewing a two-hour lease.
 */
export function reopenSession(nextSeed: Uint8Array, startedAt: number): Identity {
  return adopt(nextSeed, startedAt);
}

/** The seed behind the open session. Only the resume seal should ask for this. */
export function currentSeed(): Uint8Array | null {
  return seed;
}

/** When the PIN was entered for the session now open, or 0 while locked. */
export function sessionOpenedAt(): number {
  return identity ? openedAt : 0;
}

/** The unlocked identity, or null when locked. */
export function peekIdentity(): Identity | null {
  return identity;
}

/** The unlocked identity. Throws when locked, so callers cannot silently no-op. */
export function currentIdentity(): Identity {
  if (!identity) throw new Error("The app is locked.");
  return identity;
}

export function isUnlocked(): boolean {
  return identity !== null;
}

/** Lock: wipe every derived secret and drop cached conversation keys. */
export function closeSession(): void {
  if (identity) {
    identity.identitySk.fill(0);
    identity.kexSk.fill(0);
    identity.localDbKey.fill(0);
    identity = null;
  }
  seed?.fill(0);
  seed = null;
  openedAt = 0;
  forgetConversationKeys();
  notify();
}

/** Subscribe to lock/unlock transitions. Returns an unsubscribe function. */
export function onSessionChange(listener: (unlocked: boolean) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
