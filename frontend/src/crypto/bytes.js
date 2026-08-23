// Byte/string encoding helpers shared by the crypto layer.
// Kept dependency-free so the same code runs in the browser and in vitest.

export { bytesToHex, hexToBytes, utf8ToBytes, concatBytes, randomBytes } from "@noble/hashes/utils.js";

const CHUNK = 0x8000;

export function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

/** Constant-time byte comparison, so callers never leak position via early exit. */
export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Best-effort scrub of key material once it is no longer needed. */
export function wipe(...arrays) {
  for (const array of arrays) {
    if (array instanceof Uint8Array) array.fill(0);
  }
}
