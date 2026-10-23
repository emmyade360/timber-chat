// Keeping an unlocked session across a reload.
//
// Until now the auto-lock setting could not keep its own promise: the derived
// keys live in memory, so a hard refresh threw them away and the PIN screen came
// back no matter what had been chosen. Honouring "after 2 hours" or "never"
// means leaving something behind that a reload can pick up.
//
// What is left behind is the 64-byte seed -- not the recovery phrase -- sealed
// under an AES-GCM key generated as non-extractable. The browser will decrypt
// with that key but will not hand its bytes back to script, so the seed is never
// at rest in the clear and cannot simply be read out of the database.
//
// The honest limit: anything running in this origin can still ask the browser to
// decrypt with that key. This is convenience bounded by a policy, not defence in
// depth, which is exactly why "Every launch" exists, stores nothing, and stays
// the strictest choice.

import { STORE_VAULT, timberDb } from "../db/timberDb.js";
import { LOCK_POLICIES, canResumeSession, normalizeLockPolicy } from "../lib/lockPolicy.js";
import type { LockPolicyId } from "../types/session.js";
import { isArrayBufferBacked } from "../types/crypto.js";
import { isResumeRecord } from "../types/db.js";
import type { ResumeRecord } from "../types/db.js";
import type { Bytes } from "../types/crypto.js";


const RESUME_KEY = "resume";
const IV_BYTES = 12;

function subtle(): SubtleCrypto | null {
  return globalThis.crypto?.subtle ?? null;
}

async function put(record: ResumeRecord): Promise<void> {
  const db = await timberDb();
  await db.put(STORE_VAULT, record, RESUME_KEY);
}

/** Drop the resume token. Every lock, and every switch to "Every launch". */
export async function clearResume(): Promise<void> {
  try {
    const db = await timberDb();
    await db.delete(STORE_VAULT, RESUME_KEY);
  } catch {
    /* nothing to resume from is the safe outcome */
  }
}

/**
 * Seal the seed so a reload can re-enter this session.
 *
 * "Every launch" stores nothing and clears anything already stored, so choosing
 * it takes effect on the very next reload rather than at the end of a lease.
 */
export async function sealResume(
  seed: Uint8Array | null,
  policy: LockPolicyId,
  openedAt: number,
): Promise<boolean> {
  const crypt = subtle();
  if (normalizeLockPolicy(policy) === LOCK_POLICIES.always || !seed || !crypt) {
    await clearResume();
    return false;
  }
  if (!isArrayBufferBacked(seed)) {
    await clearResume();
    return false;
  }
  try {
    const key = await crypt.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = await crypt.encrypt({ name: "AES-GCM", iv }, key, seed);
    if (key instanceof CryptoKey === false) throw new Error("Expected a single AES key.");
    await put({ key, iv, sealed, openedAt });
    return true;
  } catch {
    // A browser that refuses to store a CryptoKey simply keeps asking for the
    // PIN. Failing closed is the right direction for this one.
    await clearResume();
    return false;
  }
}

/**
 * The seed a previous unlock left, when the policy still allows using it.
 *
 * A token that has outlived its lease -- or that belongs to a policy since
 * tightened -- is deleted here rather than merely ignored, so the window it
 * describes cannot be reopened by putting the clock back.
 */
export async function openResume(
  policy: LockPolicyId,
  now: number = Date.now(),
): Promise<{ seed: Bytes; openedAt: number } | null> {
  const crypt = subtle();
  if (normalizeLockPolicy(policy) === LOCK_POLICIES.always || !crypt) {
    await clearResume();
    return null;
  }
  let record: ResumeRecord | undefined;
  try {
    const db = await timberDb();
    const stored = await db.get(STORE_VAULT, RESUME_KEY);
    if (!isResumeRecord(stored)) return null;
    record = stored;
  } catch {
    return null;
  }
  if (!canResumeSession(policy, record.openedAt, now)) {
    await clearResume();
    return null;
  }
  try {
    const seed = new Uint8Array(
      await crypt.decrypt({ name: "AES-GCM", iv: record.iv }, record.key, record.sealed),
    );
    return { seed, openedAt: record.openedAt };
  } catch {
    await clearResume();
    return null;
  }
}
