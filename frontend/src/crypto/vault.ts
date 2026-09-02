// The vault holds the recovery phrase on this device.
//
// There are two shapes it can take, and which one is present is the whole of
// what "secured" means here.
//
//   device -- no PIN yet. The phrase is sealed under an AES-GCM key generated
//             as non-extractable, so it is never at rest in the clear, but
//             anything running in this origin can ask the browser to open it.
//             This is what a brand new account gets, so that signing up costs
//             two taps instead of six screens.
//
//   pin    -- the phrase wrapped by a key stretched from a PIN with scrypt.
//             Chosen deliberately, and only in the same flow that backs the
//             phrase up, because the phrase is what recovers a forgotten PIN.
//
// A short PIN is a small search space, so scrypt makes each guess expensive.
// The cost is recorded in the record rather than read from a constant here:
// changing a module constant would silently orphan every vault already written
// under the old cost. Note the honest limit, unchanged from the first version
// of this file: an attacker who copies the stored blob off the device can brute
// force it offline at their own pace, with only scrypt in the way. That is the
// reason for the length floor, and the reason the cost stays high even though
// it is now paid far less often -- an unlocked session resumes from
// crypto/resume.ts, and an unsecured account never pays it at all.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { base64ToBytes, bytesToBase64, bytesToUtf8, randomBytes, utf8ToBytes } from "./bytes.js";
import { deriveIdentity } from "./identity.js";
import { STORE_VAULT, destroyTimberDb, timberDb } from "../db/timberDb.js";
import { isArrayBufferBacked } from "../types/crypto.js";
import { isDeviceVaultRecord, isVaultRecord } from "../types/db.js";
import type { DeviceVaultRecord, ScryptCost, VaultIdentity, VaultRecord } from "../types/db.js";

/**
 * The unsealed half of a transfer package. Everything here arrives from a
 * scanned QR code, so it is validated field by field before it is believed --
 * `transferVault` below, never an assertion.
 */
interface TransferVault {
  salt: string;
  nonce: string;
  ciphertext: string;
  version: number;
  createdAt: unknown;
  kdf?: ScryptCost;
  identity?: VaultIdentity;
}

const VAULT_KEY = "seed";
const NONCE_BYTES = 24;
const IV_BYTES = 12;

/** Six digits is the floor for a numeric PIN; anything longer may be a passphrase. */
export const MIN_PIN_LENGTH = 6;
/** A non-numeric secret has a far larger alphabet, but needs a little more length. */
export const MIN_PASSPHRASE_LENGTH = 8;
// New secrets are capped so an accidental paste cannot make the browser spend
// unbounded time copying input before the deliberately memory-hard scrypt step.
// Existing vaults remain unlockable because unlockVault does not apply this cap.
export const MAX_PIN_LENGTH = 64;
export const MAX_ATTEMPTS = 10;

const VAULT_VERSION = 3;
// v2 records are still opened; they simply predate the recorded scrypt cost and
// the stored identity, so both are filled in from the legacy defaults.
const SUPPORTED_VAULT_VERSIONS = new Set([2, VAULT_VERSION]);

// 64 MiB of memory per guess. High enough to make offline brute force costly,
// low enough to stay under the memory ceiling of a mid-range mobile browser.
const SCRYPT_COST: ScryptCost = { N: 1 << 16, r: 8, p: 1 };
// What every record written before the cost was recorded used.
const LEGACY_SCRYPT: ScryptCost = { N: 1 << 16, r: 8, p: 1 };
const DK_LEN = 32;

function wrappingKey(pin: string, salt: Uint8Array, cost: ScryptCost): Uint8Array {
  return scrypt(utf8ToBytes(pin), salt, { ...cost, dkLen: DK_LEN });
}

/** A PIN is six or more digits; anything else must be a longer passphrase. */
export function isValidPin(pin: unknown): pin is string {
  if (typeof pin !== "string" || pin.length > MAX_PIN_LENGTH) return false;
  if (/^\d+$/.test(pin)) return pin.length >= MIN_PIN_LENGTH;
  return pin.length >= MIN_PASSPHRASE_LENGTH;
}

function subtle(): SubtleCrypto | null {
  return globalThis.crypto?.subtle ?? null;
}

async function readVault(): Promise<VaultRecord | DeviceVaultRecord | undefined> {
  const db = await timberDb();
  const record = await db.get(STORE_VAULT, VAULT_KEY);
  if (isVaultRecord(record)) return record;
  if (isDeviceVaultRecord(record)) return record;
  return undefined;
}

async function writeVault(record: VaultRecord | DeviceVaultRecord): Promise<void> {
  const db = await timberDb();
  await db.put(STORE_VAULT, record, VAULT_KEY);
}

/** Does this device already hold an account? Decides Onboarding vs the app on boot. */
export async function vaultExists(): Promise<boolean> {
  return (await readVault()) !== undefined;
}

/** Which of the two shapes is on this device, or null when there is no account. */
export async function vaultKind(): Promise<"pin" | "device" | null> {
  const record = await readVault();
  if (isDeviceVaultRecord(record)) return "device";
  if (isVaultRecord(record)) return "pin";
  return null;
}

/** True once a PIN has been set, which is also true once the phrase is backed up. */
export async function isVaultSecured(): Promise<boolean> {
  return (await vaultKind()) === "pin";
}

/** Who this device belongs to, readable before unlock so the lock screen can greet them. */
export async function vaultIdentity(): Promise<VaultIdentity | null> {
  const record = await readVault();
  return record?.identity ?? null;
}

/** Keep the recognition card in step with a changed username or avatar. */
export async function setVaultIdentity(identity: VaultIdentity): Promise<void> {
  const record = await readVault();
  if (!record) return;
  await writeVault({ ...record, identity });
}

/** Drop the plaintext identity, restoring an anonymous lock screen. */
export async function forgetVaultIdentity(): Promise<void> {
  const record = await readVault();
  if (!record?.identity) return;
  const { identity: _discarded, ...rest } = record;
  await writeVault(rest);
}

/** Remaining unlock attempts before the PIN is refused in favour of the phrase. */
export async function attemptsRemaining(): Promise<number> {
  const record = await readVault();
  if (!isVaultRecord(record)) return MAX_ATTEMPTS;
  return Math.max(0, MAX_ATTEMPTS - record.attempts);
}

/** Is the opt-in "erase this device after MAX_ATTEMPTS" setting on? */
export async function eraseOnFailureEnabled(): Promise<boolean> {
  const record = await readVault();
  return isVaultRecord(record) && record.eraseOnFailure === true;
}

export async function setEraseOnFailure(enabled: boolean): Promise<void> {
  const record = await readVault();
  if (!isVaultRecord(record)) return;
  await writeVault({ ...record, eraseOnFailure: enabled });
}

export class VaultWipedError extends Error {
  constructor() {
    super("Too many incorrect PIN attempts. This device has been erased — restore with your recovery phrase.");
    this.name = "VaultWipedError";
  }
}

export class WrongPinError extends Error {
  readonly remaining: number;

  constructor(remaining: number) {
    super(`Incorrect PIN. ${remaining} ${remaining === 1 ? "attempt" : "attempts"} remaining.`);
    this.name = "WrongPinError";
    this.remaining = remaining;
  }
}

/**
 * Thrown once the attempt budget is spent on a device that is not set to erase.
 *
 * The account is not lost and nothing has been deleted: the twelve words set a
 * new PIN and the history stays readable, because the local database key comes
 * from the seed rather than from the PIN.
 */
export class VaultLockedError extends Error {
  constructor() {
    super("Too many incorrect attempts. Use your twelve-word phrase to set a new PIN.");
    this.name = "VaultLockedError";
  }
}

/** Thrown when a phrase is valid but belongs to a different account than this device. */
export class PhraseMismatchError extends Error {
  constructor() {
    super("That phrase is valid, but it belongs to a different Timber account than the one on this device.");
    this.name = "PhraseMismatchError";
  }
}

/**
 * Seal a phrase with no PIN at all, under a non-extractable device key.
 *
 * This is what a new account gets. It writes a real vault record, because
 * `vaultExists` is what decides between onboarding and the app on boot, and it
 * costs no scrypt, so launching is immediate.
 */
export async function createDeviceVault(mnemonic: string, identity?: VaultIdentity): Promise<void> {
  const crypt = subtle();
  if (!crypt) throw new Error("This browser cannot store a Timber account securely.");

  const plaintext = utf8ToBytes(mnemonic);
  if (!isArrayBufferBacked(plaintext)) throw new Error("Could not prepare the account for storage.");

  const key = await crypt.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  if (key instanceof CryptoKey === false) throw new Error("Expected a single AES key.");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypt.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  plaintext.fill(0);

  await writeVault({
    kind: "device",
    key,
    iv,
    sealed,
    version: VAULT_VERSION,
    createdAt: Date.now(),
    ...(identity ? { identity } : {}),
  });
}

/** Open an unsecured vault. There is no PIN, so this cannot fail on a wrong guess. */
export async function openDeviceVault(): Promise<string> {
  const crypt = subtle();
  const record = await readVault();
  if (!isDeviceVaultRecord(record)) throw new Error("There is no unsecured account on this device.");
  if (!crypt) throw new Error("This browser cannot open a Timber account.");
  return bytesToUtf8(
    new Uint8Array(await crypt.decrypt({ name: "AES-GCM", iv: record.iv }, record.key, record.sealed)),
  );
}

/** Seal a phrase under a PIN and persist it. Overwrites any existing vault. */
export async function createVault(
  mnemonic: string,
  pin: string,
  { identity }: { identity?: VaultIdentity } = {},
): Promise<void> {
  if (!isValidPin(pin)) {
    throw new Error(`Your PIN needs ${MIN_PIN_LENGTH} or more digits, or ${MIN_PASSPHRASE_LENGTH} characters.`);
  }

  // Preserve the recognition card and the erase preference across a re-wrap, so
  // changing or resetting a PIN does not quietly forget who the device belongs
  // to or turn a security setting back off.
  const previous = await readVault();
  const carried = identity ?? previous?.identity;
  const erase = isVaultRecord(previous) && previous.eraseOnFailure === true;

  const salt = randomBytes(32);
  const nonce = randomBytes(NONCE_BYTES);
  const key = wrappingKey(pin, salt, SCRYPT_COST);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(utf8ToBytes(mnemonic));
  key.fill(0);

  await writeVault({
    salt: bytesToBase64(salt),
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
    attempts: 0,
    version: VAULT_VERSION,
    createdAt: Date.now(),
    kdf: SCRYPT_COST,
    ...(carried ? { identity: carried } : {}),
    ...(erase ? { eraseOnFailure: true } : {}),
  });
}

/**
 * Open the vault, returning the recovery phrase.
 *
 * A failed attempt is recorded before the error is thrown, so force-quitting the
 * app mid-guess cannot be used to get unlimited tries. Spending the whole budget
 * no longer destroys anything unless the owner opted into that: it refuses the
 * PIN and points at the phrase, which sets a new one without losing history.
 */
export async function unlockVault(pin: string): Promise<string> {
  const record = await readVault();
  if (isDeviceVaultRecord(record)) return openDeviceVault();
  if (!isVaultRecord(record)) throw new Error("There is no account on this device.");
  if (record.attempts >= MAX_ATTEMPTS) throw new VaultLockedError();

  const key = wrappingKey(pin, base64ToBytes(record.salt), record.kdf ?? LEGACY_SCRYPT);
  try {
    const mnemonic = bytesToUtf8(
      xchacha20poly1305(key, base64ToBytes(record.nonce)).decrypt(base64ToBytes(record.ciphertext)),
    );
    if (record.attempts) await writeVault({ ...record, attempts: 0 });
    return mnemonic;
  } catch {
    const attempts = record.attempts + 1;
    if (attempts >= MAX_ATTEMPTS && record.eraseOnFailure === true) {
      await destroyTimberDb();
      throw new VaultWipedError();
    }
    await writeVault({ ...record, attempts });
    if (attempts >= MAX_ATTEMPTS) throw new VaultLockedError();
    throw new WrongPinError(MAX_ATTEMPTS - attempts);
  } finally {
    key.fill(0);
  }
}

/**
 * Put a PIN on an account that did not have one.
 *
 * Callers must have shown and confirmed the phrase first. That ordering is the
 * invariant the whole recovery model rests on: a PIN with no backed-up phrase
 * is the one combination that can strand someone permanently.
 */
export async function secureVaultWithPin(pin: string): Promise<void> {
  const mnemonic = await openDeviceVault();
  await createVault(mnemonic, pin);
}

/** Re-wrap the phrase under a new PIN. Requires the current one. */
export async function changePin(currentPin: string, nextPin: string): Promise<void> {
  const mnemonic = await unlockVault(currentPin);
  await createVault(mnemonic, nextPin);
}

/**
 * Set a new PIN using the recovery phrase, for someone who has forgotten it.
 *
 * Nothing is deleted. `identityFromSeed` derives the local database key from the
 * seed and not from the PIN, so re-wrapping leaves every stored message readable
 * -- which is the entire point of routing a forgotten PIN through here instead
 * of through wipeDevice.
 *
 * The phrase is checked against the account this device already holds. Resetting
 * with a different valid phrase would succeed cryptographically and then leave
 * the local history encrypted under a seed nobody has, which looks exactly like
 * silent data loss.
 */
export async function resetPinWithPhrase(phrase: string, nextPin: string): Promise<void> {
  const identity = deriveIdentity(phrase);
  const known = await vaultIdentity();
  if (known && known.userId !== identity.userId) throw new PhraseMismatchError();
  // A vault written before identities were recorded has nothing to check
  // against, so this reset is taken on trust -- but the id is kept afterwards,
  // which means it only ever happens once per device. The username is filled in
  // by the next bootstrap; an empty one simply leaves the lock screen anonymous.
  await createVault(phrase, nextPin, {
    identity: known ?? { userId: identity.userId, username: "" },
  });
}

/**
 * A QR-safe transfer package contains the existing PIN-encrypted vault record,
 * never the mnemonic. The receiving device must still know the current PIN.
 * It intentionally excludes messages; those are restored as ciphertext through
 * the authenticated sync relay after sign-in.
 *
 * An unsecured account has no PIN to protect the package with, so it must be
 * given one before it can be transferred.
 */
export async function exportVaultTransfer(): Promise<string> {
  const record = await readVault();
  if (isDeviceVaultRecord(record)) {
    throw new Error("Set a PIN before transferring this account to another device.");
  }
  if (!isVaultRecord(record)) throw new Error("There is no vault to transfer from this device.");
  const packageData = {
    v: 1,
    vault: {
      salt: record.salt,
      nonce: record.nonce,
      ciphertext: record.ciphertext,
      version: record.version,
      createdAt: record.createdAt,
      // The cost travels with the record, or the receiving device would stretch
      // the same PIN differently and never open it.
      ...(record.kdf ? { kdf: record.kdf } : {}),
      // So the new device recognises its owner on the very first lock screen.
      ...(record.identity ? { identity: record.identity } : {}),
      // A new physical device begins its own local unlock-attempt counter.
      attempts: 0,
    },
  };
  return `timber-vault/v1:${bytesToBase64(utf8ToBytes(JSON.stringify(packageData)))}`;
}

function scryptCost(value: unknown): ScryptCost | null {
  if (typeof value !== "object" || value === null) return null;
  const { N, r, p } = value as Record<string, unknown>;
  if (typeof N !== "number" || typeof r !== "number" || typeof p !== "number") return null;
  // A hostile package must not be able to name a cost that hangs the browser or
  // one so cheap it makes the PIN trivially guessable on the receiving device.
  if (!Number.isInteger(N) || N < 1 << 12 || N > 1 << 20) return null;
  if (!Number.isInteger(r) || r < 1 || r > 16) return null;
  if (!Number.isInteger(p) || p < 1 || p > 4) return null;
  return { N, r, p };
}

function vaultIdentityOf(value: unknown): VaultIdentity | null {
  if (typeof value !== "object" || value === null) return null;
  const { userId, username, avatarUrl, level, levelName } = value as Record<string, unknown>;
  if (typeof userId !== "string" || typeof username !== "string") return null;
  if (userId.length > 64 || username.length > 64) return null;
  return {
    userId,
    username,
    ...(typeof avatarUrl === "string" ? { avatarUrl } : {}),
    ...(typeof level === "number" ? { level } : {}),
    ...(typeof levelName === "string" ? { levelName } : {}),
  };
}

/**
 * Validate a scanned transfer package field by field.
 *
 * Length checks matter as much as the type checks: a salt or nonce of the wrong
 * size would be accepted by the decryptor and produce a vault that can never be
 * opened, which looks to the user like a lost account rather than a bad scan.
 */
function transferVault(packageData: unknown): TransferVault | null {
  if (typeof packageData !== "object" || packageData === null) return null;
  const outer = packageData as { v?: unknown; vault?: unknown };
  if (outer.v !== 1) return null;
  if (typeof outer.vault !== "object" || outer.vault === null) return null;

  const vault = outer.vault as Record<string, unknown>;
  const { salt, nonce, ciphertext, version, createdAt, kdf, identity } = vault;
  if (typeof version !== "number" || !SUPPORTED_VAULT_VERSIONS.has(version)) return null;
  if (typeof salt !== "string" || typeof nonce !== "string" || typeof ciphertext !== "string") return null;
  try {
    if (base64ToBytes(salt).length !== 32) return null;
    if (base64ToBytes(nonce).length !== NONCE_BYTES) return null;
    if (base64ToBytes(ciphertext).length === 0) return null;
  } catch {
    return null;
  }
  const cost = kdf === undefined ? null : scryptCost(kdf);
  if (kdf !== undefined && !cost) return null;
  const owner = identity === undefined ? null : vaultIdentityOf(identity);
  if (identity !== undefined && !owner) return null;
  return {
    salt,
    nonce,
    ciphertext,
    version,
    createdAt,
    ...(cost ? { kdf: cost } : {}),
    ...(owner ? { identity: owner } : {}),
  };
}

/** Import an encrypted transfer package during first-run setup only. */
export async function importVaultTransfer(value: string): Promise<void> {
  const encoded = value.trim().replace(/^timber-vault\/v1:/, "");
  let packageData: unknown;
  try {
    packageData = JSON.parse(bytesToUtf8(base64ToBytes(encoded)));
  } catch {
    throw new Error("That is not a valid Timber transfer package.");
  }
  const vault = transferVault(packageData);
  if (!vault) throw new Error("That transfer package is incomplete or has been altered.");
  const existing = await readVault();
  if (isVaultRecord(existing)) {
    // Retrying a PIN or a transient sign-in failure must not strand the new
    // device after the first import. A different vault still cannot overwrite it.
    if (existing.salt === vault.salt && existing.nonce === vault.nonce && existing.ciphertext === vault.ciphertext) return;
    throw new Error("This device already has a different Timber vault. Remove it before importing another one.");
  }
  if (isDeviceVaultRecord(existing)) {
    throw new Error("This device already has a Timber account. Remove it before importing another one.");
  }
  await writeVault({
    salt: vault.salt,
    nonce: vault.nonce,
    ciphertext: vault.ciphertext,
    version: vault.version,
    attempts: 0,
    createdAt: typeof vault.createdAt === "number" && Number.isSafeInteger(vault.createdAt)
      ? vault.createdAt
      : Date.now(),
    ...(vault.kdf ? { kdf: vault.kdf } : {}),
    ...(vault.identity ? { identity: vault.identity } : {}),
  });
}

/** Remove the account and all local history from this device. */
export async function wipeDevice(): Promise<void> {
  await destroyTimberDb();
}
