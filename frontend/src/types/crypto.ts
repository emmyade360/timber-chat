// Key material contracts.
//
// Every secret here is a live `Uint8Array` that `closeSession` zeroes in place.
// None of it is ever serialised: not into the Zustand store, not into a
// devtools snapshot, not into local storage. The types exist to make an
// accidental `JSON.stringify` of an identity a compile error rather than a
// silent key leak.

/**
 * A view WebCrypto will accept. `BufferSource` excludes SharedArrayBuffer-backed
 * views, while the crypto libraries return the wider `Uint8Array` default.
 * Timber never creates a shared buffer, but `isArrayBufferBacked` below proves
 * it at the boundary rather than assuming it -- an assertion here would be a
 * silent lie about memory that holds key material.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export function isArrayBufferBacked(view: Uint8Array): view is Bytes {
  return view.buffer instanceof ArrayBuffer;
}

/** The full key material derived from one BIP39 seed. */
export interface Identity {
  /** UUIDv8 derived from the identity public key. Stable across devices. */
  userId: string;
  /** Ed25519 signing key. Secret. */
  identitySk: Uint8Array;
  identityPk: Uint8Array;
  /** X25519 key-agreement key. Secret. */
  kexSk: Uint8Array;
  kexPk: Uint8Array;
  /** Symmetric key for the on-device encrypted store. Secret. */
  localDbKey: Uint8Array;
}

export interface ConversationKeyInput {
  conversationId: string;
  kexSk: Uint8Array;
  peerKexPk: Uint8Array;
  userId: string;
  peerUserId: string;
}
