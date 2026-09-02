// Byte/string encoding helpers shared by the crypto layer.
// Kept dependency-free so the same code runs in the browser and in vitest.

export { bytesToHex, hexToBytes, utf8ToBytes, concatBytes, randomBytes } from "@noble/hashes/utils.js";

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Constant-time byte comparison, so callers never leak position via early exit. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  // Both indices are in range: the lengths were just proved equal. `?? 0`
  // satisfies noUncheckedIndexedAccess without changing the arithmetic.
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Best-effort scrub of key material once it is no longer needed. */
export function wipe(...arrays: (Uint8Array | null | undefined)[]): void {
  for (const array of arrays) {
    if (array instanceof Uint8Array) array.fill(0);
  }
}
