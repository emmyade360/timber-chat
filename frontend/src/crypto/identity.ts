// Non-custodial identity: one 12-word BIP39 phrase is the entire account.
//
// The phrase never leaves the device and is never sent to the server. Everything
// below is derived from it locally, with HKDF domain separation so that a leak of
// one derived key can never expose the others.
//
//   mnemonic -> 64-byte seed
//     |- HKDF("timber/identity/ed25519/v1") -> Ed25519 keypair  (login signatures)
//     |- HKDF("timber/kex/x25519/v1")       -> X25519 keypair   (ECDH with peers)
//     '- HKDF("timber/localdb/v1")          -> local database key (encryption at rest)

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64ToBytes, bytesToBase64, bytesToHex, concatBytes, utf8ToBytes } from "./bytes.js";
import type { Identity } from "../types/crypto.js";

/** A key given either as raw bytes or as the base64 the wire uses. */
type KeyInput = Uint8Array | string;

const asBytes = (key: KeyInput): Uint8Array =>
  typeof key === "string" ? base64ToBytes(key) : key;

/** 128 bits of entropy -> 12 words. */
const ENTROPY_BITS = 128;

/** Fixed application salt. Public by design; HKDF's security rests on the seed. */
const APP_SALT = utf8ToBytes("timber/hkdf/v1");

const DOMAIN_IDENTITY = utf8ToBytes("timber/identity/ed25519/v1");
const DOMAIN_KEX = utf8ToBytes("timber/kex/x25519/v1");
const DOMAIN_LOCAL_DB = utf8ToBytes("timber/localdb/v1");
const KEY_BINDING_DOMAIN = utf8ToBytes("timber/key-binding/v1\0");

export const MNEMONIC_WORDS = 12;
export const wordlistEnglish = wordlist;

/** Create a fresh 12-word recovery phrase. */
export function createMnemonic(): string {
  return generateMnemonic(wordlist, ENTROPY_BITS);
}

/** Normalise user input: collapse whitespace, lowercase. Does not validate. */
export function normalizeMnemonic(phrase: string): string {
  return String(phrase).trim().toLowerCase().split(/\s+/u).join(" ");
}

/** True when the phrase is a well-formed BIP39 mnemonic with a valid checksum. */
export function isValidMnemonic(phrase: string): boolean {
  return validateMnemonic(normalizeMnemonic(phrase), wordlist);
}

/**
 * Words that are not in the BIP39 English wordlist, so the import screen can point
 * at the exact word the user mistyped instead of only saying "invalid phrase".
 */
export function unknownWords(phrase: string): string[] {
  const words = normalizeMnemonic(phrase).split(" ").filter(Boolean);
  const known = new Set(wordlist);
  return words.filter((word) => !known.has(word));
}

function derive(seed: Uint8Array, domain: Uint8Array): Uint8Array {
  return hkdf(sha256, seed, APP_SALT, domain, 32);
}

/**
 * Format 16 bytes as an RFC 9562 UUIDv8 (custom). Version and variant bits are
 * pinned so the value is a legal UUID for Postgres' UUID column; the remaining
 * 122 bits come from the hash. The backend repeats this derivation exactly, which
 * is what lets it map a public key to an account id without a lookup table.
 */
function bytesToUuidV8(bytes: Uint8Array): string {
  const id = bytes.slice(0, 16);
  if (id.length < 16) throw new Error("Need 16 bytes to form a UUID.");
  id[6] = ((id[6] ?? 0) & 0x0f) | 0x80; // version 8
  id[8] = ((id[8] ?? 0) & 0x3f) | 0x80; // RFC variant
  const hex = bytesToHex(id);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Account id for an Ed25519 public key. Deterministic and offline. */
export function userIdForPublicKey(identityPk: Uint8Array): string {
  return bytesToUuidV8(sha256(identityPk));
}

/** The 64-byte BIP39 seed for a phrase, which every key below descends from. */
export function mnemonicSeed(mnemonic: string): Uint8Array {
  const phrase = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(phrase, wordlist)) {
    throw new Error("That recovery phrase is not valid.");
  }
  return mnemonicToSeedSync(phrase);
}

/**
 * Derive the full key material from a seed.
 *
 * The returned object holds live secret keys; keep it in memory only. Callers that
 * persist anything must go through vault.js (phrase) or localStore.js (messages).
 *
 * Resuming a session across a reload re-enters the derivation here, from a sealed
 * copy of the seed, so the recovery phrase itself is never stored anywhere but the
 * PIN-sealed vault.
 */
export function identityFromSeed(seed: Uint8Array): Identity {
  const identitySk = derive(seed, DOMAIN_IDENTITY);
  const kexSk = derive(seed, DOMAIN_KEX);
  const localDbKey = derive(seed, DOMAIN_LOCAL_DB);

  const identityPk = ed25519.getPublicKey(identitySk);
  const kexPk = x25519.getPublicKey(kexSk);

  return {
    userId: userIdForPublicKey(identityPk),
    identitySk,
    identityPk,
    kexSk,
    kexPk,
    localDbKey,
  };
}

/** Derive the full key material for a phrase. */
export function deriveIdentity(mnemonic: string): Identity {
  return identityFromSeed(mnemonicSeed(mnemonic));
}

/** Public half of an identity, in the shape the register/login endpoints expect. */
export function publicIdentity(identity: Identity): { user_id: string; identity_pk: string; kex_pk: string } {
  return {
    user_id: identity.userId,
    identity_pk: bytesToBase64(identity.identityPk),
    kex_pk: bytesToBase64(identity.kexPk),
  };
}

function uuidToBytes(value: string): Uint8Array {
  const compact = String(value).replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/iu.test(compact)) throw new Error("Invalid account identifier.");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Bytes an identity key signs to certify its deterministic X25519 public key. */
export function kexKeyBindingBytes(
  { userId, identityPk, kexPk }: { userId: string; identityPk: KeyInput; kexPk: KeyInput },
): Uint8Array {
  const identityKey = asBytes(identityPk);
  const exchangeKey = asBytes(kexPk);
  if (identityKey.length !== 32 || exchangeKey.length !== 32) {
    throw new Error("Identity and chat keys must be 32 bytes.");
  }
  return concatBytes(KEY_BINDING_DOMAIN, uuidToBytes(userId), identityKey, exchangeKey);
}

/** Certify the key agreement public key with the account's Ed25519 signing key. */
export function signKexKeyBinding(identity: Identity): string {
  return bytesToBase64(ed25519.sign(kexKeyBindingBytes(identity), identity.identitySk));
}

/**
 * Verify a peer record before it is used for ECDH.  This makes key substitution
 * by the relay detectable: it cannot invent a matching Ed25519 signature.
 */
export function verifyKexKeyBinding(
  { userId, identityPk, kexPk, kexKeySignature }: {
    userId: string; identityPk: KeyInput; kexPk: KeyInput; kexKeySignature: KeyInput;
  },
): boolean {
  try {
    const identityKey = asBytes(identityPk);
    const signature = asBytes(kexKeySignature);
    if (identityKey.length !== 32 || signature.length !== 64) return false;
    if (userIdForPublicKey(identityKey) !== userId) return false;
    return ed25519.verify(
      signature,
      kexKeyBindingBytes({ userId, identityPk: identityKey, kexPk }),
      identityKey,
    );
  } catch {
    return false;
  }
}

/** A short, deterministic fingerprint users can compare out of band. */
export function safetyFingerprint(
  { userId, identityPk, peerUserId, peerIdentityPk }: {
    userId: string; identityPk: KeyInput; peerUserId: string; peerIdentityPk: KeyInput;
  },
): string {
  const first = { id: userId, key: asBytes(identityPk) };
  const second = { id: peerUserId, key: asBytes(peerIdentityPk) };
  // Both devices must hash the same two records in the same order, or the
  // fingerprints disagree. Ordering the pair directly says that more plainly
  // than sorting a two-element array, and needs no assertion to stay typed.
  const ascending = first.id.localeCompare(second.id) <= 0;
  const left = ascending ? first : second;
  const right = ascending ? second : first;
  const digest = sha256(concatBytes(
    utf8ToBytes("timber/safety-number/v1\0"),
    uuidToBytes(left.id),
    left.key,
    uuidToBytes(right.id),
    right.key,
  ));
  return (bytesToHex(digest).match(/.{1,4}/g) ?? []).join(" ");
}

/** Sign a server-issued login challenge. Proves key possession without revealing it. */
export function signChallenge(identity: Identity, nonceBytes: Uint8Array): string {
  return bytesToBase64(ed25519.sign(nonceBytes, identity.identitySk));
}
