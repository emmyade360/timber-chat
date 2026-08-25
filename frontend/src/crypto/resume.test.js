// The auto-lock setting used to be advisory: whatever was chosen, a hard refresh
// threw the keys away and the PIN screen came back. These cover the part that
// makes the choice real, and the parts that keep it bounded.

import { afterEach, describe, expect, it } from "vitest";
import { LOCK_POLICIES, SESSION_LEASE_MS } from "../lib/lockPolicy.js";
import { STORE_VAULT, timberDb } from "../db/timberDb.js";
import { clearResume, openResume, sealResume } from "./resume.js";

const seed = () => new Uint8Array(64).fill(7);
const unlocked = () => Date.now();

const storedRecord = async () => (await timberDb()).get(STORE_VAULT, "resume");

afterEach(async () => { await clearResume(); });

describe("resuming a session after a reload", () => {
  it("hands back the same seed within the two-hour lease", async () => {
    const openedAt = unlocked();
    expect(await sealResume(seed(), LOCK_POLICIES.twoHours, openedAt)).toBe(true);

    const resumed = await openResume(LOCK_POLICIES.twoHours, openedAt + 60_000);
    expect(resumed.openedAt).toBe(openedAt);
    expect([...resumed.seed]).toEqual([...seed()]);
  });

  it("stores nothing under the strict policy", async () => {
    expect(await sealResume(seed(), LOCK_POLICIES.always, unlocked())).toBe(false);
    expect(await storedRecord()).toBeUndefined();
    expect(await openResume(LOCK_POLICIES.always)).toBe(null);
  });

  it("drops a token the moment the policy is tightened", async () => {
    const openedAt = unlocked();
    await sealResume(seed(), LOCK_POLICIES.never, openedAt);
    // Reading under the stricter policy must not merely decline to use the
    // token; leaving it behind would reopen the window on the next loosening.
    expect(await openResume(LOCK_POLICIES.always, openedAt + 1)).toBe(null);
    expect(await storedRecord()).toBeUndefined();
  });

  it("expires with the lease and deletes itself", async () => {
    const openedAt = unlocked();
    await sealResume(seed(), LOCK_POLICIES.twoHours, openedAt);
    expect(await openResume(LOCK_POLICIES.twoHours, openedAt + SESSION_LEASE_MS)).toBe(null);
    expect(await storedRecord()).toBeUndefined();
  });

  it("keeps resuming indefinitely when automatic locking is off", async () => {
    const openedAt = unlocked();
    await sealResume(seed(), LOCK_POLICIES.never, openedAt);
    const later = openedAt + 30 * 24 * 60 * 60 * 1000;
    expect((await openResume(LOCK_POLICIES.never, later)).openedAt).toBe(openedAt);
  });

  it("never writes the seed where it could be read back", async () => {
    await sealResume(seed(), LOCK_POLICIES.never, unlocked());
    const record = await storedRecord();
    // Non-extractable: the browser will decrypt with this key but will not hand
    // its bytes to script, so the sealed seed is the only copy at rest.
    expect(record.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", record.key)).rejects.toThrow();
    const sealed = new Uint8Array(record.sealed);
    expect([...sealed]).not.toEqual([...seed()]);
    expect(sealed.length).toBeGreaterThan(seed().length); // seed + GCM tag
  });

  it("asks for the PIN again once the token is gone", async () => {
    await sealResume(seed(), LOCK_POLICIES.never, unlocked());
    await clearResume();
    expect(await openResume(LOCK_POLICIES.never)).toBe(null);
  });
});
