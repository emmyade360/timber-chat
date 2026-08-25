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

export function lockPolicyLabel(value) {
  return ({
    [LOCK_POLICIES.always]: "Every login",
    [LOCK_POLICIES.twoHours]: "After 2 hours",
    [LOCK_POLICIES.never]: "Never automatically",
  })[normalizeLockPolicy(value)];
}
