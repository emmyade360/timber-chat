// The vault holds the recovery phrase on this device, sealed under a PIN.
//
// Typing twelve words to open the app would be unusable, so the phrase is wrapped
// with a key stretched from a short PIN and stored in IndexedDB. The raw seed only
// ever exists in memory, for the lifetime of an unlocked session.
//
// A short PIN is a small search space, so it is defended two ways: scrypt makes each
// guess expensive, and the vault self-destructs after MAX_ATTEMPTS failures. Wiping
// is safe precisely because this is a non-custodial account -- the recovery phrase
// restores it. Note the honest limit: an attacker who copies the stored blob off the
// device can brute force it offline at their own pace, with only scrypt in the way.
// That is the reason for the PIN length floor.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { base64ToBytes, bytesToBase64, bytesToUtf8, randomBytes, utf8ToBytes } from "./bytes.js";
import { STORE_VAULT, destroyTimberDb, timberDb } from "../db/timberDb.js";

const VAULT_KEY = "seed";
const NONCE_BYTES = 24;

export const MIN_PIN_LENGTH = 8;
export const MAX_ATTEMPTS = 10;
const VAULT_VERSION = 2;

// 64 MiB of memory per guess. High enough to make offline brute force costly,
// low enough to stay under the memory ceiling of a mid-range mobile browser.
const SCRYPT_PARAMS = { N: 1 << 16, r: 8, p: 1, dkLen: 32 };

function wrappingKey(pin, salt) {
  return scrypt(utf8ToBytes(pin), salt, SCRYPT_PARAMS);
}

export function isValidPin(pin) {
  return typeof pin === "string" && new RegExp(`^\\d{${MIN_PIN_LENGTH},}$`).test(pin);
}

/** Does this device already hold an account? Decides Onboarding vs Unlock on boot. */
export async function vaultExists() {
  const db = await timberDb();
  return (await db.get(STORE_VAULT, VAULT_KEY)) !== undefined;
}

/** Remaining unlock attempts before the vault wipes itself. */
export async function attemptsRemaining() {
  const db = await timberDb();
  const record = await db.get(STORE_VAULT, VAULT_KEY);
  if (!record) return 0;
  return Math.max(0, MAX_ATTEMPTS - (record.attempts ?? 0));
}

/** Seal a phrase under a PIN and persist it. Overwrites any existing vault. */
export async function createVault(mnemonic, pin) {
  if (!isValidPin(pin)) {
    throw new Error(`Your PIN needs at least ${MIN_PIN_LENGTH} characters.`);
  }

  const salt = randomBytes(32);
  const nonce = randomBytes(NONCE_BYTES);
  const key = wrappingKey(pin, salt);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(utf8ToBytes(mnemonic));
  key.fill(0);

  const db = await timberDb();
  await db.put(
    STORE_VAULT,
    {
      salt: bytesToBase64(salt),
      nonce: bytesToBase64(nonce),
      ciphertext: bytesToBase64(ciphertext),
      attempts: 0,
      version: VAULT_VERSION,
      createdAt: Date.now(),
    },
    VAULT_KEY,
  );
}

/** Old local records still unlock, but newly written records use the PIN policy. */
export async function vaultNeedsUpgrade() {
  const db = await timberDb();
  const record = await db.get(STORE_VAULT, VAULT_KEY);
  return Boolean(record && record.version !== VAULT_VERSION);
}

export class VaultWipedError extends Error {
  constructor() {
    super("Too many incorrect PIN attempts. This device has been wiped — restore with your recovery phrase.");
    this.name = "VaultWipedError";
  }
}

export class WrongPinError extends Error {
  constructor(remaining) {
    super(`Incorrect PIN. ${remaining} ${remaining === 1 ? "attempt" : "attempts"} remaining.`);
    this.name = "WrongPinError";
    this.remaining = remaining;
  }
}

/**
 * Open the vault, returning the recovery phrase.
 *
 * A failed attempt is recorded before the error is thrown, so force-quitting the
 * app mid-guess cannot be used to get unlimited tries.
 */
export async function unlockVault(pin) {
  const db = await timberDb();
  const record = await db.get(STORE_VAULT, VAULT_KEY);
  if (!record) throw new Error("There is no account on this device.");

  const key = wrappingKey(pin, base64ToBytes(record.salt));
  try {
    const mnemonic = bytesToUtf8(
      xchacha20poly1305(key, base64ToBytes(record.nonce)).decrypt(base64ToBytes(record.ciphertext)),
    );
    if (record.attempts) {
      await db.put(STORE_VAULT, { ...record, attempts: 0 }, VAULT_KEY);
    }
    return mnemonic;
  } catch {
    const attempts = (record.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await destroyTimberDb();
      throw new VaultWipedError();
    }
    await db.put(STORE_VAULT, { ...record, attempts }, VAULT_KEY);
    throw new WrongPinError(MAX_ATTEMPTS - attempts);
  } finally {
    key.fill(0);
  }
}

/** Re-wrap the phrase under a new PIN. Requires the current one. */
export async function changePin(currentPin, nextPin) {
  const mnemonic = await unlockVault(currentPin);
  await createVault(mnemonic, nextPin);
}

/**
 * A QR-safe transfer package contains the existing PIN-encrypted vault record,
 * never the mnemonic. The receiving device must still know the current PIN.
 * It intentionally excludes messages; those are restored as ciphertext through
 * the authenticated sync relay after sign-in.
 */
export async function exportVaultTransfer() {
  const db = await timberDb();
  const record = await db.get(STORE_VAULT, VAULT_KEY);
  if (!record) throw new Error("There is no vault to transfer from this device.");
  const packageData = {
    v: 1,
    vault: {
      salt: record.salt,
      nonce: record.nonce,
      ciphertext: record.ciphertext,
      version: record.version,
      createdAt: record.createdAt,
      // A new physical device begins its own local unlock-attempt counter.
      attempts: 0,
    },
  };
  return `timber-vault/v1:${bytesToBase64(utf8ToBytes(JSON.stringify(packageData)))}`;
}

/** Import an encrypted transfer package during first-run setup only. */
export async function importVaultTransfer(value) {
  const encoded = value.trim().replace(/^timber-vault\/v1:/, "");
  let packageData;
  try {
    packageData = JSON.parse(bytesToUtf8(base64ToBytes(encoded)));
  } catch {
    throw new Error("That is not a valid Timber transfer package.");
  }
  const vault = packageData?.v === 1 ? packageData.vault : null;
  const valid = vault
    && vault.version === VAULT_VERSION
    && typeof vault.salt === "string"
    && base64ToBytes(vault.salt).length === 32
    && typeof vault.nonce === "string"
    && base64ToBytes(vault.nonce).length === NONCE_BYTES
    && typeof vault.ciphertext === "string"
    && base64ToBytes(vault.ciphertext).length > 0;
  if (!valid) throw new Error("That transfer package is incomplete or has been altered.");
  const db = await timberDb();
  const existing = await db.get(STORE_VAULT, VAULT_KEY);
  if (existing) {
    // Retrying a PIN or a transient sign-in failure must not strand the new
    // device after the first import. A different vault still cannot overwrite it.
    if (existing.salt === vault.salt && existing.nonce === vault.nonce && existing.ciphertext === vault.ciphertext) return;
    throw new Error("This device already has a different Timber vault. Remove it before importing another one.");
  }
  await db.put(STORE_VAULT, {
    salt: vault.salt,
    nonce: vault.nonce,
    ciphertext: vault.ciphertext,
    version: VAULT_VERSION,
    attempts: 0,
    createdAt: Number.isSafeInteger(vault.createdAt) ? vault.createdAt : Date.now(),
  }, VAULT_KEY);
}

/** Remove the account and all local history from this device. */
export async function wipeDevice() {
  await destroyTimberDb();
}
