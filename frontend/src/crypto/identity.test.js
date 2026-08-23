import { describe, expect, it } from "vitest";
import {
  createMnemonic,
  deriveIdentity,
  isValidMnemonic,
  normalizeMnemonic,
  publicIdentity,
  signKexKeyBinding,
  signChallenge,
  unknownWords,
  userIdForPublicKey,
  verifyKexKeyBinding,
} from "./identity.js";
import { base64ToBytes, bytesToBase64, utf8ToBytes } from "./bytes.js";
import { ed25519 } from "@noble/curves/ed25519.js";

// The canonical BIP39 all-zero-entropy vector.
const VECTOR =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("mnemonic handling", () => {
  it("generates a valid 12-word phrase", () => {
    const phrase = createMnemonic();
    expect(phrase.split(" ")).toHaveLength(12);
    expect(isValidMnemonic(phrase)).toBe(true);
  });

  it("generates a different phrase every time", () => {
    expect(createMnemonic()).not.toBe(createMnemonic());
  });

  it("normalises casing and stray whitespace before validating", () => {
    expect(normalizeMnemonic("  ABANDON   abandon\tAbout ")).toBe("abandon abandon about");
    expect(isValidMnemonic(VECTOR.toUpperCase())).toBe(true);
    expect(isValidMnemonic(`  ${VECTOR}  `)).toBe(true);
  });

  it("rejects a phrase whose checksum does not hold", () => {
    const wrongChecksum = VECTOR.replace(/about$/, "abandon");
    expect(isValidMnemonic(wrongChecksum)).toBe(false);
    expect(() => deriveIdentity(wrongChecksum)).toThrow(/not valid/i);
  });

  it("names the specific words that are not in the wordlist", () => {
    expect(unknownWords("abandon zzzz about qqqq")).toEqual(["zzzz", "qqqq"]);
    expect(unknownWords(VECTOR)).toEqual([]);
  });
});

describe("key derivation", () => {
  it("derives stable keys for a known phrase", () => {
    // Regression vector. A change here means every existing account's id and keys
    // would move, silently orphaning their history and their username.
    const identity = deriveIdentity(VECTOR);
    expect(identity.userId).toBe("ebf9dc0b-6877-87dc-bc70-cacac5805257");
    expect(bytesToBase64(identity.identityPk)).toBe("s9gArXUimYYiZD5iUexlszJHUZZYRz9GLUyk27AvLMo=");
    expect(bytesToBase64(identity.kexPk)).toBe("Fx2BLB3tRwBxbO/vTSfGQIalKeIgbNagbIYWJ6n90hg=");
    expect(bytesToBase64(identity.localDbKey)).toBe("TceMRDdbtbZQqWaDUTXRv1geAEs34T5fYpbFuFuRH7o=");
  });

  it("produces a well-formed UUIDv8 account id", () => {
    const { userId } = deriveIdentity(VECTOR);
    expect(userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("keeps the three derived keys independent", () => {
    const { identitySk, kexSk, localDbKey } = deriveIdentity(VECTOR);
    const asHex = [identitySk, kexSk, localDbKey].map(bytesToBase64);
    expect(new Set(asHex).size).toBe(3);
  });

  it("derives different identities for different phrases", () => {
    expect(deriveIdentity(createMnemonic()).userId).not.toBe(deriveIdentity(createMnemonic()).userId);
  });

  it("recovers the same account when the phrase is re-imported", () => {
    const phrase = createMnemonic();
    expect(deriveIdentity(phrase).userId).toBe(deriveIdentity(phrase).userId);
  });

  it("derives the account id from the public key alone", () => {
    const identity = deriveIdentity(VECTOR);
    // The backend only ever sees the public key, so it must reach the same id.
    expect(userIdForPublicKey(identity.identityPk)).toBe(identity.userId);
  });
});

describe("login challenge", () => {
  it("produces a signature the public key verifies", () => {
    const identity = deriveIdentity(VECTOR);
    const nonce = utf8ToBytes("server-issued-nonce");
    const signature = base64ToBytes(signChallenge(identity, nonce));
    expect(ed25519.verify(signature, nonce, identity.identityPk)).toBe(true);
  });

  it("does not verify against a different nonce", () => {
    const identity = deriveIdentity(VECTOR);
    const signature = base64ToBytes(signChallenge(identity, utf8ToBytes("nonce-a")));
    expect(ed25519.verify(signature, utf8ToBytes("nonce-b"), identity.identityPk)).toBe(false);
  });

  it("never exposes a secret in the public identity payload", () => {
    const identity = deriveIdentity(VECTOR);
    const wire = JSON.stringify(publicIdentity(identity));
    for (const secret of [identity.identitySk, identity.kexSk, identity.localDbKey]) {
      expect(wire).not.toContain(bytesToBase64(secret));
    }
  });
});

describe("chat-key binding", () => {
  it("certifies the deterministic chat key with the identity key", () => {
    const identity = deriveIdentity(VECTOR);
    expect(verifyKexKeyBinding({
      userId: identity.userId,
      identityPk: identity.identityPk,
      kexPk: identity.kexPk,
      kexKeySignature: signKexKeyBinding(identity),
    })).toBe(true);
  });

  it("rejects a substituted chat key or account id", () => {
    const identity = deriveIdentity(VECTOR);
    const signature = signKexKeyBinding(identity);
    const substituted = identity.kexPk.slice();
    substituted[0] ^= 1;
    expect(verifyKexKeyBinding({
      userId: identity.userId,
      identityPk: identity.identityPk,
      kexPk: substituted,
      kexKeySignature: signature,
    })).toBe(false);
    expect(verifyKexKeyBinding({
      userId: "00000000-0000-8000-8000-000000000000",
      identityPk: identity.identityPk,
      kexPk: identity.kexPk,
      kexKeySignature: signature,
    })).toBe(false);
  });
});
