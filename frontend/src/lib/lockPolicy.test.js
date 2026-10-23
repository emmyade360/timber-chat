import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCK_POLICY,
  LOCK_POLICIES,
  LOCK_POLICY_STORAGE_KEY,
  SESSION_LEASE_MS,
  WEEK_LEASE_MS,
  canResumeSession,
  lockPolicyLabel,
  normalizeLockPolicy,
  readLockPolicy,
  sessionDeadline,
  writeLockPolicy,
} from "./lockPolicy.js";

describe("auto-lock preference", () => {
  it("defaults safely to the two-hour session", () => {
    // A week, not two hours: the PIN costs 64 MiB of scrypt to check, so the
    // old default made a consumer messenger pause several times a day.
    expect(DEFAULT_LOCK_POLICY).toBe(LOCK_POLICIES.week);
    expect(readLockPolicy({ getItem: () => "invalid" })).toBe(LOCK_POLICIES.week);
    expect(normalizeLockPolicy(undefined)).toBe(LOCK_POLICIES.week);
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

describe("what a reload is allowed to do", () => {
  const unlocked = 1_000_000_000_000;

  it("always asks for the PIN under the strict policy", () => {
    // This is the whole of what "Every launch" buys, so it must not soften.
    expect(canResumeSession(LOCK_POLICIES.always, unlocked, unlocked + 1)).toBe(false);
    expect(sessionDeadline(LOCK_POLICIES.always, unlocked)).toBe(null);
  });

  it("never asks again when automatic locking is off", () => {
    const muchLater = unlocked + 400 * 24 * 60 * 60 * 1000;
    expect(canResumeSession(LOCK_POLICIES.never, unlocked, muchLater)).toBe(true);
    expect(sessionDeadline(LOCK_POLICIES.never, unlocked)).toBe(null);
  });

  it("continues the two-hour lease across a reload rather than restarting it", () => {
    // Reloading in minute 119 must leave one minute, not another two hours --
    // otherwise refreshing would keep a session open indefinitely.
    const deadline = sessionDeadline(LOCK_POLICIES.twoHours, unlocked);
    expect(deadline).toBe(unlocked + SESSION_LEASE_MS);
    expect(canResumeSession(LOCK_POLICIES.twoHours, unlocked, deadline - 1)).toBe(true);
    expect(canResumeSession(LOCK_POLICIES.twoHours, unlocked, deadline)).toBe(false);
    expect(canResumeSession(LOCK_POLICIES.twoHours, unlocked, deadline + 1)).toBe(false);
  });

  it("refuses a lease that has no honest start", () => {
    for (const policy of Object.values(LOCK_POLICIES)) {
      expect(canResumeSession(policy, 0, unlocked)).toBe(false);
      expect(canResumeSession(policy, Number.NaN, unlocked)).toBe(false);
      // Winding the device clock back must not hand out a fresh window.
      expect(canResumeSession(policy, unlocked, unlocked - 1)).toBe(false);
    }
  });
});

describe("the week-long default", () => {
  it("resumes for a week and then stops", () => {
    const unlocked = 1_700_000_000_000;
    const deadline = sessionDeadline(LOCK_POLICIES.week, unlocked);
    expect(deadline).toBe(unlocked + WEEK_LEASE_MS);
    expect(canResumeSession(LOCK_POLICIES.week, unlocked, deadline - 1)).toBe(true);
    expect(canResumeSession(LOCK_POLICIES.week, unlocked, deadline)).toBe(false);
  });

  // Loosening the default must not loosen the strict choices with it.
  it("leaves the stricter choices exactly as they were", () => {
    const unlocked = 1_700_000_000_000;
    expect(canResumeSession(LOCK_POLICIES.always, unlocked, unlocked + 1)).toBe(false);
    expect(sessionDeadline(LOCK_POLICIES.twoHours, unlocked)).toBe(unlocked + SESSION_LEASE_MS);
    expect(canResumeSession(LOCK_POLICIES.twoHours, unlocked, unlocked + SESSION_LEASE_MS)).toBe(false);
  });

  it("cannot be extended by putting the clock back", () => {
    const unlocked = 1_700_000_000_000;
    expect(canResumeSession(LOCK_POLICIES.week, unlocked, unlocked - 1)).toBe(false);
  });
});
