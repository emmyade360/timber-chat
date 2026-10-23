// Device-only auto-lock preference.
//
// This is deliberately presentation/session policy, not vault data. It never
// contains a PIN, recovery phrase, identity key, or account identifier, so it
// can be read before the vault is unlocked to decide how long the current
// decrypted session may remain open.

import type { LockPolicyId } from "../types/session.js";

export const LOCK_POLICY_STORAGE_KEY = "timber-lock-policy";
export const LOCK_POLICIES = Object.freeze({
  always: "always",
  twoHours: "two-hours",
  week: "week",
  never: "never",
} as const satisfies Record<string, LockPolicyId>);

/**
 * A week, not two hours.
 *
 * Two hours is the right default for Signal's threat model and a punishing one
 * for a consumer messenger: it means re-entering a PIN several times a day, and
 * the PIN is stretched with 64 MiB of scrypt, so each one is a visible pause.
 * The stricter choices are untouched and one tap away for anyone who wants
 * them -- this changes the default, not the options.
 */
export const DEFAULT_LOCK_POLICY = LOCK_POLICIES.week;

/** How long the two-hour choice keeps a session open, counted from the unlock. */
export const SESSION_LEASE_MS = 2 * 60 * 60 * 1000;
/** The same, for the week-long default. */
export const WEEK_LEASE_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a policy keeps a session open, or null when it sets no deadline. */
function leaseFor(policy: LockPolicyId): number | null {
  if (policy === LOCK_POLICIES.twoHours) return SESSION_LEASE_MS;
  if (policy === LOCK_POLICIES.week) return WEEK_LEASE_MS;
  return null;
}

export function normalizeLockPolicy(value: unknown): LockPolicyId {
  const policies: readonly LockPolicyId[] = Object.values(LOCK_POLICIES);
  return policies.includes(value as LockPolicyId) ? (value as LockPolicyId) : DEFAULT_LOCK_POLICY;
}

export function readLockPolicy(storage: Storage | undefined = globalThis?.localStorage): LockPolicyId {
  try {
    return normalizeLockPolicy(storage?.getItem(LOCK_POLICY_STORAGE_KEY));
  } catch {
    return DEFAULT_LOCK_POLICY;
  }
}

export function writeLockPolicy(value: unknown, storage: Storage | undefined = globalThis?.localStorage): LockPolicyId {
  const policy = normalizeLockPolicy(value);
  try { storage?.setItem(LOCK_POLICY_STORAGE_KEY, policy); } catch { /* optional preference */ }
  return policy;
}

/**
 * When a session unlocked at `openedAt` must lock, or null when the policy sets
 * no deadline of its own. "Always" returns null because it locks on idle and on
 * reload instead, and "never" because it does not lock by itself at all.
 */
export function sessionDeadline(policy: unknown, openedAt: number): number | null {
  const lease = leaseFor(normalizeLockPolicy(policy));
  if (lease === null) return null;
  if (!Number.isFinite(openedAt) || openedAt <= 0) return null;
  return openedAt + lease;
}

/**
 * May a reload skip the lock screen for a session unlocked at `openedAt`?
 *
 * This is the whole of the promise the setting makes. "Always" is the strict
 * choice and never resumes; "never" resumes indefinitely; two hours resumes
 * only while the lease from the original unlock is still running -- a reload
 * continues that lease rather than starting a new one.
 */
export function canResumeSession(policy: unknown, openedAt: number, now: number = Date.now()): boolean {
  const selected = normalizeLockPolicy(policy);
  if (selected === LOCK_POLICIES.always) return false;
  if (!Number.isFinite(openedAt) || openedAt <= 0) return false;
  // A clock that has moved backwards must not be able to extend a lease.
  if (openedAt > now) return false;
  const lease = leaseFor(selected);
  if (lease === null) return true;
  return now < openedAt + lease;
}

export function lockPolicyLabel(value: unknown): string {
  return ({
    [LOCK_POLICIES.always]: "Every launch",
    [LOCK_POLICIES.twoHours]: "After 2 hours",
    [LOCK_POLICIES.week]: "After a week",
    [LOCK_POLICIES.never]: "Never automatically",
  })[normalizeLockPolicy(value)];
}

/** What the choice actually does, in the row under the setting. */
export function lockPolicyDescription(value: unknown): string {
  return ({
    [LOCK_POLICIES.always]: "PIN on every launch, and after 5 minutes idle",
    [LOCK_POLICIES.twoHours]: "PIN once, then again 2 hours later — reloads included",
    [LOCK_POLICIES.week]: "PIN once a week — reloads included",
    [LOCK_POLICIES.never]: "No PIN until you lock Timber yourself",
  })[normalizeLockPolicy(value)];
}
