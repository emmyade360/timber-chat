// Device-only auto-lock preference.
//
// This is deliberately presentation/session policy, not vault data. It never
// contains a PIN, recovery phrase, identity key, or account identifier, so it
// can be read before the vault is unlocked to decide how long the current
// decrypted session may remain open.

export const LOCK_POLICY_STORAGE_KEY = "timber-lock-policy";
export const LOCK_POLICIES = Object.freeze({
  always: "always",
  twoHours: "two-hours",
  never: "never",
});

export const DEFAULT_LOCK_POLICY = LOCK_POLICIES.twoHours;

/** How long the two-hour choice keeps a session open, counted from the unlock. */
export const SESSION_LEASE_MS = 2 * 60 * 60 * 1000;

export function normalizeLockPolicy(value) {
  return Object.values(LOCK_POLICIES).includes(value) ? value : DEFAULT_LOCK_POLICY;
}

export function readLockPolicy(storage = globalThis?.localStorage) {
  try {
    return normalizeLockPolicy(storage?.getItem(LOCK_POLICY_STORAGE_KEY));
  } catch {
    return DEFAULT_LOCK_POLICY;
  }
}

export function writeLockPolicy(value, storage = globalThis?.localStorage) {
  const policy = normalizeLockPolicy(value);
  try { storage?.setItem(LOCK_POLICY_STORAGE_KEY, policy); } catch { /* optional preference */ }
  return policy;
}

/**
 * When a session unlocked at `openedAt` must lock, or null when the policy sets
 * no deadline of its own. "Always" returns null because it locks on idle and on
 * reload instead, and "never" because it does not lock by itself at all.
 */
export function sessionDeadline(policy, openedAt) {
  if (normalizeLockPolicy(policy) !== LOCK_POLICIES.twoHours) return null;
  if (!Number.isFinite(openedAt) || openedAt <= 0) return null;
  return openedAt + SESSION_LEASE_MS;
}

/**
 * May a reload skip the lock screen for a session unlocked at `openedAt`?
 *
 * This is the whole of the promise the setting makes. "Always" is the strict
 * choice and never resumes; "never" resumes indefinitely; two hours resumes
 * only while the lease from the original unlock is still running -- a reload
 * continues that lease rather than starting a new one.
 */
export function canResumeSession(policy, openedAt, now = Date.now()) {
  const selected = normalizeLockPolicy(policy);
  if (selected === LOCK_POLICIES.always) return false;
  if (!Number.isFinite(openedAt) || openedAt <= 0) return false;
  // A clock that has moved backwards must not be able to extend a lease.
  if (openedAt > now) return false;
  if (selected === LOCK_POLICIES.never) return true;
  return now < openedAt + SESSION_LEASE_MS;
}

export function lockPolicyLabel(value) {
  return ({
    [LOCK_POLICIES.always]: "Every launch",
    [LOCK_POLICIES.twoHours]: "After 2 hours",
    [LOCK_POLICIES.never]: "Never automatically",
  })[normalizeLockPolicy(value)];
}

/** What the choice actually does, in the row under the setting. */
export function lockPolicyDescription(value) {
  return ({
    [LOCK_POLICIES.always]: "PIN on every launch, and after 5 minutes idle",
    [LOCK_POLICIES.twoHours]: "PIN once, then again 2 hours later — reloads included",
    [LOCK_POLICIES.never]: "No PIN until you lock Timber yourself",
  })[normalizeLockPolicy(value)];
}
