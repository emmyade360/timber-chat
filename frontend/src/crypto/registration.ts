// A signup is durable before the first request that can create a server account.
// The pending record is device-sealed, not an active vault or a resume token.
import { STORE_VAULT, timberDb } from "../db/timberDb.js";
import { bytesToUtf8, utf8ToBytes } from "./bytes.js";
import { deriveIdentity, isValidMnemonic } from "./identity.js";
import { makeDeviceVaultRecord } from "./vault.js";
import { isDeviceVaultRecord, isPendingRegistrationRecord } from "../types/db.js";
import { isArrayBufferBacked } from "../types/crypto.js";
import type { PendingRegistrationRecord } from "../types/db.js";

const PENDING_KEY = "pending-registration";
const ACTIVE_KEY = "seed";

export interface RegistrationDraft {
  mnemonic: string;
  username: string;
  isAnonymous: boolean;
  inviteCode: string | null;
}

export interface PendingRegistration extends RegistrationDraft {
  userId: string;
}

export interface RegisteredAccount {
  user_id: string;
  username: string;
  is_anonymous: boolean;
}

async function seal(draft: RegistrationDraft): Promise<PendingRegistrationRecord> {
  if (!globalThis.crypto?.subtle) throw new Error("This browser cannot save your account securely.");
  const userId = deriveIdentity(draft.mnemonic).userId;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = utf8ToBytes(JSON.stringify(draft));
  if (!isArrayBufferBacked(plaintext)) throw new Error("Could not prepare signup for secure storage.");
  try {
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    return { kind: "pending-registration", userId, key, iv, sealed, version: 1, createdAt: Date.now() };
  } finally {
    plaintext.fill(0);
  }
}

async function open(record: PendingRegistrationRecord): Promise<PendingRegistration> {
  const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv }, record.key, record.sealed));
  try {
    const draft: unknown = JSON.parse(bytesToUtf8(bytes));
    if (typeof draft !== "object" || draft === null
      || !("mnemonic" in draft) || typeof draft.mnemonic !== "string" || !isValidMnemonic(draft.mnemonic)
      || !("username" in draft) || typeof draft.username !== "string"
      || !("isAnonymous" in draft) || typeof draft.isAnonymous !== "boolean"
      || !("inviteCode" in draft) || (draft.inviteCode !== null && typeof draft.inviteCode !== "string")
      || deriveIdentity(draft.mnemonic).userId !== record.userId) {
      throw new Error("The unfinished signup could not be opened. Keep this device’s data and try again.");
    }
    return { mnemonic: draft.mnemonic, username: draft.username, isAnonymous: draft.isAnonymous,
      inviteCode: draft.inviteCode, userId: record.userId };
  } finally {
    bytes.fill(0);
  }
}

export async function pendingRegistration(): Promise<PendingRegistration | null> {
  const db = await timberDb();
  const record = await db.get(STORE_VAULT, PENDING_KEY);
  if (!record) return null;
  if (!isPendingRegistrationRecord(record)) throw new Error("This device’s unfinished signup cannot be read safely.");
  return open(record);
}

/** The first tab wins. A later tab adopts it instead of replacing its keys. */
export async function stageRegistration(draft: RegistrationDraft): Promise<PendingRegistration> {
  const candidate = await seal(draft);
  const db = await timberDb();
  const tx = db.transaction(STORE_VAULT, "readwrite");
  const active = await tx.store.get(ACTIVE_KEY);
  const previous = await tx.store.get(PENDING_KEY);
  if (active || (previous && !isPendingRegistrationRecord(previous))) {
    await tx.done;
    throw new Error("This device already holds an account. Reopen Timber to continue it.");
  }
  // Editing the username on the same pending identity is safe; a competing
  // candidate is never allowed to replace the winning identity or mode.
  const selected = isPendingRegistrationRecord(previous)
    ? previous.userId === candidate.userId ? { ...candidate, createdAt: previous.createdAt } : previous
    : candidate;
  await tx.store.put(selected, PENDING_KEY);
  await tx.done;
  // Verify that the committed CryptoKey can be read back before using it online.
  const committed = await db.get(STORE_VAULT, PENDING_KEY);
  if (!isPendingRegistrationRecord(committed) || committed.userId !== selected.userId) {
    throw new Error("Signup finished or changed in another tab. Reopen Timber to continue.");
  }
  return open(committed);
}

/** Promote the same identity, atomically, only after a signed server response. */
export async function finishRegistration(pending: PendingRegistration, account: RegisteredAccount): Promise<void> {
  if (account.user_id !== pending.userId || account.is_anonymous !== pending.isAnonymous
    || typeof account.username !== "string" || !/^[a-z0-9_]{3,20}$/.test(account.username)) {
    throw new Error("The account response did not match this device’s signup. Keep this device’s data and retry.");
  }
  const active = await makeDeviceVaultRecord(pending.mnemonic,
    { userId: account.user_id, username: account.username }, account.is_anonymous);
  const db = await timberDb();
  const tx = db.transaction(STORE_VAULT, "readwrite");
  const existing = await tx.store.get(ACTIVE_KEY);
  const current = await tx.store.get(PENDING_KEY);
  if (existing) {
    await tx.done;
    if (isDeviceVaultRecord(existing) && existing.ownerId === pending.userId) return;
    throw new Error("This device already has a different account. Its keys were kept safe.");
  }
  if (!isPendingRegistrationRecord(current) || current.userId !== pending.userId) {
    await tx.done;
    throw new Error("The unfinished signup changed in another tab. Reopen Timber to continue.");
  }
  await tx.store.put(active, ACTIVE_KEY);
  await tx.store.delete(PENDING_KEY);
  await tx.done;
}
