// A reload is the case the auto-lock setting exists for, and the case it used to
// get wrong: whatever was chosen, the keys were gone and the PIN screen came
// back. Losing the module state below is what a hard refresh actually does to
// this app, so these drive the real modules through it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth.js", () => ({ signIn: vi.fn(async () => ({})) }));

import { createMnemonic } from "../crypto/identity.js";
import { closeSession, isUnlocked, peekIdentity, sessionOpenedAt } from "../crypto/session.js";
import { clearResume } from "../crypto/resume.js";
import { LOCK_POLICIES, SESSION_LEASE_MS } from "./lockPolicy.js";
import { applyLockPolicy, beginSession, endSession, restoreSession } from "./lockSession.js";

const mnemonic = createMnemonic();

/** Everything a hard refresh takes with it: the keys, not the database. */
const reload = () => closeSession();

const UNLOCKED_AT = new Date("2026-03-01T09:00:00Z");
const skipTo = (ms) => vi.setSystemTime(new Date(UNLOCKED_AT.getTime() + ms));

// Only Date is faked. fake-indexeddb drives its transactions off real timers,
// and replacing those deadlocks every await in here.
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(UNLOCKED_AT); });
afterEach(async () => { vi.useRealTimers(); closeSession(); await clearResume(); });

describe("carrying an unlocked session across a reload", () => {
  it("comes back without a PIN when automatic locking is off", async () => {
    const opened = await beginSession(mnemonic, LOCK_POLICIES.never);
    const unlockedAt = sessionOpenedAt();

    reload();
    expect(isUnlocked()).toBe(false);

    skipTo(31 * 24 * 60 * 60 * 1000);
    expect(await restoreSession(LOCK_POLICIES.never)).toBe(true);
    expect(isUnlocked()).toBe(true);
    expect(peekIdentity().userId).toBe(opened.userId);
    // The original unlock, not the reload: a lease is never renewed by refreshing.
    expect(sessionOpenedAt()).toBe(unlockedAt);
  });

  it("still asks for the PIN under the strict policy", async () => {
    await beginSession(mnemonic, LOCK_POLICIES.always);
    reload();
    expect(await restoreSession(LOCK_POLICIES.always)).toBe(false);
    expect(isUnlocked()).toBe(false);
  });

  it("resumes inside the two-hour lease and stops at the end of it", async () => {
    await beginSession(mnemonic, LOCK_POLICIES.twoHours);
    reload();

    skipTo(SESSION_LEASE_MS - 60_000);
    expect(await restoreSession(LOCK_POLICIES.twoHours)).toBe(true);

    reload();
    skipTo(SESSION_LEASE_MS);
    expect(await restoreSession(LOCK_POLICIES.twoHours)).toBe(false);
    expect(isUnlocked()).toBe(false);
  });

  it("applies a tightened policy on the next load, not at the end of the lease", async () => {
    await beginSession(mnemonic, LOCK_POLICIES.never);
    await applyLockPolicy(LOCK_POLICIES.always);
    reload();
    expect(await restoreSession(LOCK_POLICIES.always)).toBe(false);
  });

  it("starts resuming as soon as automatic locking is turned off", async () => {
    // Nothing was stored under the strict policy, so loosening it has to seal
    // the session already open rather than wait for the next unlock.
    await beginSession(mnemonic, LOCK_POLICIES.always);
    await applyLockPolicy(LOCK_POLICIES.never);
    reload();
    expect(await restoreSession(LOCK_POLICIES.never)).toBe(true);
  });

  it("asks for the PIN after an explicit lock, whatever the policy says", async () => {
    await beginSession(mnemonic, LOCK_POLICIES.never);
    await endSession();
    expect(isUnlocked()).toBe(false);
    expect(await restoreSession(LOCK_POLICIES.never)).toBe(false);
  });
});
