// One place that knows how unlocking, locking, and the auto-lock policy fit
// together, so every entry point leaves the same state behind.
//
// Opening a session and deciding what a reload is allowed to do with it were
// previously separate concerns, which is how the setting ended up advertising a
// behaviour the app did not have. They are one operation here.

import { closeSession, currentSeed, openSession, reopenSession, sessionOpenedAt } from "../crypto/session.js";
import { clearResume, openResume, sealResume } from "../crypto/resume.js";
import { LOCK_POLICIES, normalizeLockPolicy, readLockPolicy, writeLockPolicy } from "./lockPolicy.js";
import { signIn } from "./auth.js";

/** Unlock: open the session and leave whatever resume token the policy allows. */
export async function beginSession(mnemonic, policy = readLockPolicy()) {
  const identity = openSession(mnemonic);
  await sealResume(currentSeed(), policy, sessionOpenedAt());
  return identity;
}

/**
 * Boot straight into the app when the saved policy still permits it.
 *
 * Returns false when the PIN screen is required, which is both the "Every
 * launch" answer and the answer for an expired two-hour lease.
 */
export async function restoreSession(policy = readLockPolicy()) {
  const token = await openResume(policy);
  if (!token) return false;
  const identity = reopenSession(token.seed, token.openedAt);
  // The API token is held in memory only, so a resumed session signs in again.
  // Offline that fails and the app opens on local history, exactly as it does
  // when the network drops mid-session.
  await signIn(identity).catch(() => {});
  return true;
}

/** Lock: wipe the live keys and the resume token together. */
export function endSession() {
  closeSession();
  return clearResume();
}

/**
 * Save an auto-lock choice and make it true immediately.
 *
 * Tightening to "Every launch" drops the resume token now rather than at the
 * end of the current lease, and loosening it seals one from the session already
 * open, so neither choice waits for the next unlock to take effect.
 */
export async function applyLockPolicy(next) {
  const policy = writeLockPolicy(next);
  if (normalizeLockPolicy(policy) === LOCK_POLICIES.always) {
    await clearResume();
  } else {
    await sealResume(currentSeed(), policy, sessionOpenedAt());
  }
  return policy;
}
