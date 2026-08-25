import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCK_POLICY,
  LOCK_POLICIES,
  LOCK_POLICY_STORAGE_KEY,
  lockPolicyLabel,
  normalizeLockPolicy,
  readLockPolicy,
  writeLockPolicy,
} from "./lockPolicy.js";

describe("auto-lock preference", () => {
  it("defaults safely to the two-hour session", () => {
    expect(DEFAULT_LOCK_POLICY).toBe(LOCK_POLICIES.twoHours);
    expect(readLockPolicy({ getItem: () => "invalid" })).toBe(LOCK_POLICIES.twoHours);
    expect(normalizeLockPolicy(undefined)).toBe(LOCK_POLICIES.twoHours);
  });

  it("persists only a non-sensitive policy value", () => {
    const writes = [];
    const storage = {
      getItem: () => LOCK_POLICIES.always,
      setItem: (...entry) => writes.push(entry),
    };
    expect(readLockPolicy(storage)).toBe(LOCK_POLICIES.always);
    expect(writeLockPolicy(LOCK_POLICIES.never, storage)).toBe(LOCK_POLICIES.never);
    expect(writes).toEqual([[LOCK_POLICY_STORAGE_KEY, LOCK_POLICIES.never]]);
    expect(lockPolicyLabel(LOCK_POLICIES.twoHours)).toBe("After 2 hours");
  });
});
