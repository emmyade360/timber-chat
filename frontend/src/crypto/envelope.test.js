import { beforeEach, describe, expect, it } from "vitest";
import { createMnemonic, deriveIdentity } from "./identity.js";
import {
  ENVELOPE_VERSION,
  MAX_CIPHERTEXT_BYTES,
  conversationKey,
  decryptFile,
  encryptFile,
  forgetConversationKeys,
  open,
  payloads,
  seal,
} from "./envelope.js";
import { base64ToBytes, bytesEqual, bytesToBase64, utf8ToBytes } from "./bytes.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";

const CONVERSATION = "0f5f2b6a-1111-8222-8333-444455556666";
const OTHER_SENDER = "aaaaaaaa-1111-8222-8333-444455556666";

/** Two independent accounts, as they would exist on two separate devices. */
function pair() {
  const alice = deriveIdentity(createMnemonic());
  const bob = deriveIdentity(createMnemonic());
  const forAlice = conversationKey({
    conversationId: CONVERSATION,
    kexSk: alice.kexSk,
    peerKexPk: bob.kexPk,
    userId: alice.userId,
    peerUserId: bob.userId,
  });
  const forBob = conversationKey({
    conversationId: CONVERSATION,
    kexSk: bob.kexSk,
    peerKexPk: alice.kexPk,
    userId: bob.userId,
    peerUserId: alice.userId,
  });
  return { alice, bob, forAlice, forBob };
}

beforeEach(() => forgetConversationKeys());

describe("conversation key agreement", () => {
  it("lets both peers derive the identical key without exchanging it", () => {
    const { forAlice, forBob } = pair();
    expect(bytesEqual(forAlice, forBob)).toBe(true);
  });

  it("derives the key from public keys only, so ordering does not matter", () => {
    const { alice, bob, forAlice } = pair();
    // forgetConversationKeys wipes cached keys in place, so snapshot before clearing.
    const snapshot = forAlice.slice();
    forgetConversationKeys();
    // Recompute with the arguments transposed; the sorted user ids must cancel it out.
    const again = conversationKey({
      conversationId: CONVERSATION,
      kexSk: bob.kexSk,
      peerKexPk: bytesToBase64(alice.kexPk), // base64 accepted as well as bytes
      userId: bob.userId,
      peerUserId: alice.userId,
    });
    expect(bytesEqual(snapshot, again)).toBe(true);
  });

  it("gives unrelated pairs unrelated keys", () => {
    const first = pair().forAlice.slice();
    forgetConversationKeys();
    const second = pair().forAlice.slice();
    expect(bytesEqual(first, second)).toBe(false);
  });

  it("zeroes cached key material when the session locks", () => {
    const { forAlice } = pair();
    forgetConversationKeys();
    expect(forAlice.every((byte) => byte === 0)).toBe(true);
  });
});

describe("sealing and opening", () => {
  it("round-trips a text message between two peers", () => {
    const { alice, forAlice, forBob } = pair();
    const envelope = seal({
      key: forAlice,
      conversationId: CONVERSATION,
      senderId: alice.userId,
      payload: payloads.text("meet me by the old oak"),
    });
    const opened = open({
      key: forBob,
      conversationId: CONVERSATION,
      senderId: alice.userId,
      envelope,
    });
    expect(opened).toEqual({ v: ENVELOPE_VERSION, t: "text", body: "meet me by the old oak" });
  });

  it("continues to open a version-one envelope during the forward-only upgrade", () => {
    const { alice, forBob, forAlice } = pair();
    const nonce = randomBytes(24);
    const payload = { v: 1, t: "text", body: "legacy history" };
    const ciphertext = xchacha20poly1305(forAlice, nonce, utf8ToBytes(`1:${CONVERSATION}:${alice.userId}`))
      .encrypt(utf8ToBytes(JSON.stringify(payload)));
    expect(open({
      key: forBob,
      conversationId: CONVERSATION,
      senderId: alice.userId,
      envelope: { envelope_version: 1, nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(ciphertext) },
    })).toEqual(payload);
  });

  it("emits only opaque base64 and a version, never the plaintext", () => {
    const { alice, forAlice } = pair();
    const envelope = seal({
      key: forAlice,
      conversationId: CONVERSATION,
      senderId: alice.userId,
      payload: payloads.text("SECRETWORD"),
    });
    expect(Object.keys(envelope).sort()).toEqual(["ciphertext", "envelope_version", "nonce"]);
    expect(JSON.stringify(envelope)).not.toContain("SECRETWORD");
  });

  it("uses a fresh nonce per message, so identical text never repeats a ciphertext", () => {
    const { alice, forAlice } = pair();
    const args = {
      key: forAlice,
      conversationId: CONVERSATION,
      senderId: alice.userId,
      payload: payloads.text("same words"),
    };
    expect(seal(args).ciphertext).not.toBe(seal(args).ciphertext);
  });

  it("survives unicode and emoji intact", () => {
    const { alice, forAlice, forBob } = pair();
    const body = "🪵 àéîõü 中文 — done";
    const envelope = seal({
      key: forAlice,
      conversationId: CONVERSATION,
      senderId: alice.userId,
      payload: payloads.text(body),
    });
    expect(
      open({ key: forBob, conversationId: CONVERSATION, senderId: alice.userId, envelope }).body,
    ).toBe(body);
  });

  it("refuses to seal a message past the server's ciphertext cap", () => {
    const { alice, forAlice } = pair();
    expect(() =>
      seal({
        key: forAlice,
        conversationId: CONVERSATION,
        senderId: alice.userId,
        payload: payloads.text("x".repeat(MAX_CIPHERTEXT_BYTES + 1)),
      }),
    ).toThrow(/too long/i);
  });
});

describe("tamper resistance", () => {
  function sealed() {
    const p = pair();
    return {
      ...p,
      envelope: seal({
        key: p.forAlice,
        conversationId: CONVERSATION,
        senderId: p.alice.userId,
        payload: payloads.text("original"),
      }),
    };
  }

  it("rejects a ciphertext with a single flipped bit", () => {
    const { alice, forBob, envelope } = sealed();
    const bytes = base64ToBytes(envelope.ciphertext);
    bytes[0] ^= 1;
    expect(() =>
      open({
        key: forBob,
        conversationId: CONVERSATION,
        senderId: alice.userId,
        envelope: { ...envelope, ciphertext: bytesToBase64(bytes) },
      }),
    ).toThrow();
  });

  it("rejects a swapped nonce", () => {
    const { alice, forAlice, forBob, envelope } = sealed();
    const other = seal({
      key: forAlice,
      conversationId: CONVERSATION,
      senderId: alice.userId,
      payload: payloads.text("other"),
    });
    expect(() =>
      open({
        key: forBob,
        conversationId: CONVERSATION,
        senderId: alice.userId,
        envelope: { ...envelope, nonce: other.nonce },
      }),
    ).toThrow();
  });

  it("rejects a message replayed into a different conversation", () => {
    const { alice, forBob, envelope } = sealed();
    expect(() =>
      open({
        key: forBob,
        conversationId: "99999999-1111-8222-8333-444455556666",
        senderId: alice.userId,
        envelope,
      }),
    ).toThrow();
  });

  it("rejects a message re-attributed to a different sender", () => {
    const { forBob, envelope } = sealed();
    // This is what stops the server rewriting who said what.
    expect(() =>
      open({ key: forBob, conversationId: CONVERSATION, senderId: OTHER_SENDER, envelope }),
    ).toThrow();
  });

  it("rejects an unknown envelope version rather than guessing", () => {
    const { alice, forBob, envelope } = sealed();
    expect(() =>
      open({
        key: forBob,
        conversationId: CONVERSATION,
        senderId: alice.userId,
        envelope: { ...envelope, envelope_version: 99 },
      }),
    ).toThrow(/unsupported/i);
  });

  it("cannot be opened by a third party who is not in the conversation", () => {
    const { alice, envelope } = sealed();
    const eve = deriveIdentity(createMnemonic());
    const eveKey = conversationKey({
      conversationId: CONVERSATION,
      kexSk: eve.kexSk,
      peerKexPk: alice.kexPk,
      userId: eve.userId,
      peerUserId: alice.userId,
    });
    expect(() =>
      open({ key: eveKey, conversationId: CONVERSATION, senderId: alice.userId, envelope }),
    ).toThrow();
  });
});

describe("attachments", () => {
  it("round-trips a file through its own single-use key", () => {
    const original = utf8ToBytes("pretend this is a photo");
    const { blob, key } = encryptFile(original);
    expect(bytesEqual(decryptFile(blob, key), original)).toBe(true);
  });

  it("produces a blob that reveals nothing without the key", () => {
    const { blob } = encryptFile(utf8ToBytes("SECRETFILE"));
    expect(new TextDecoder().decode(blob)).not.toContain("SECRETFILE");
  });

  it("gives every upload a different key", () => {
    const bytes = utf8ToBytes("same file contents");
    expect(encryptFile(bytes).key).not.toBe(encryptFile(bytes).key);
  });

  it("rejects a tampered blob", () => {
    const { blob, key } = encryptFile(utf8ToBytes("payload"));
    blob[blob.length - 1] ^= 1;
    expect(() => decryptFile(blob, key)).toThrow();
  });
});
