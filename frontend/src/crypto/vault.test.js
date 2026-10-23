import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_ATTEMPTS,
  MAX_PIN_LENGTH,
  MIN_PASSPHRASE_LENGTH,
  MIN_PIN_LENGTH,
  PhraseMismatchError,
  VaultLockedError,
  VaultWipedError,
  WrongPinError,
  attemptsRemaining,
  changePin,
  createDeviceVault,
  createVault,
  eraseOnFailureEnabled,
  exportVaultTransfer,
  forgetVaultIdentity,
  importVaultTransfer,
  isValidPin,
  isVaultSecured,
  openDeviceVault,
  resetPinWithPhrase,
  secureVaultWithPin,
  setEraseOnFailure,
  setVaultIdentity,
  unlockVault,
  vaultExists,
  vaultIdentity,
  vaultKind,
  wipeDevice,
} from "./vault.js";
import { createMnemonic, deriveIdentity } from "./identity.js";

const PHRASE = createMnemonic();
const PIN = "31415926";

beforeEach(async () => {
  await wipeDevice();
});

describe("pin policy", () => {
  it("enforces a minimum length", () => {
    expect(isValidPin("1".repeat(MIN_PIN_LENGTH))).toBe(true);
    expect(isValidPin("1".repeat(MIN_PIN_LENGTH - 1))).toBe(false);
    expect(isValidPin("a".repeat(MIN_PASSPHRASE_LENGTH))).toBe(true);
    expect(isValidPin("a".repeat(MIN_PASSPHRASE_LENGTH - 1))).toBe(false);
    expect(isValidPin("1".repeat(MAX_PIN_LENGTH + 1))).toBe(false);
    expect(isValidPin("")).toBe(false);
  });

  it("refuses to create a vault with a short pin", async () => {
    await expect(createVault(PHRASE, "123")).rejects.toThrow(/digits/i);
  });

  it("accepts an eight-digit PIN", async () => {
    await createVault(PHRASE, "12345678");
    await expect(unlockVault("12345678")).resolves.toBe(PHRASE);
  });
});

describe("locking and unlocking", () => {
  it("reports no account before a vault is created", async () => {
    expect(await vaultExists()).toBe(false);
  });

  it("returns the exact phrase after a round trip", async () => {
    await createVault(PHRASE, PIN);
    expect(await vaultExists()).toBe(true);
    expect(await unlockVault(PIN)).toBe(PHRASE);
  });

  it("stores the phrase encrypted, never in the clear", async () => {
    await createVault(PHRASE, PIN);
    const { timberDb, STORE_VAULT } = await import("../db/timberDb.js");
    const record = await (await timberDb()).get(STORE_VAULT, "seed");
    const serialised = JSON.stringify(record);
    for (const word of PHRASE.split(" ")) {
      expect(serialised).not.toContain(word);
    }
  });

  it("uses a fresh salt per vault, so the same pin yields a different blob", async () => {
    await createVault(PHRASE, PIN);
    const { timberDb, STORE_VAULT } = await import("../db/timberDb.js");
    const first = await (await timberDb()).get(STORE_VAULT, "seed");
    await createVault(PHRASE, PIN);
    const second = await (await timberDb()).get(STORE_VAULT, "seed");
    expect(first.salt).not.toBe(second.salt);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("rejects the wrong pin and reports the attempts left", async () => {
    await createVault(PHRASE, PIN);
    await expect(unlockVault("000000")).rejects.toThrow(WrongPinError);
    expect(await attemptsRemaining()).toBe(MAX_ATTEMPTS - 1);
  });

  it("resets the attempt counter after a successful unlock", async () => {
    await createVault(PHRASE, PIN);
    await expect(unlockVault("000000")).rejects.toThrow(WrongPinError);
    expect(await attemptsRemaining()).toBe(MAX_ATTEMPTS - 1);
    await unlockVault(PIN);
    expect(await attemptsRemaining()).toBe(MAX_ATTEMPTS);
  });

  it("counts a failed attempt before throwing, so quitting mid-guess is not a free retry", async () => {
    await createVault(PHRASE, PIN);
    await expect(unlockVault("000000")).rejects.toThrow();
    await expect(unlockVault("111111")).rejects.toThrow();
    expect(await attemptsRemaining()).toBe(MAX_ATTEMPTS - 2);
  });
});

describe("self-destruct", () => {
  it("wipes the device after the attempt limit only when that was opted into", async () => {
    await createVault(PHRASE, PIN);
    await setEraseOnFailure(true);
    expect(await eraseOnFailureEnabled()).toBe(true);
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await expect(unlockVault("000000")).rejects.toThrow(WrongPinError);
    }
    await expect(unlockVault("000000")).rejects.toThrow(VaultWipedError);

    expect(await vaultExists()).toBe(false);
    // The correct pin must not resurrect it either.
    await expect(unlockVault(PIN)).rejects.toThrow(/no account/i);
  }, 60_000);

  it("clears everything on an explicit wipe", async () => {
    await createVault(PHRASE, PIN);
    await wipeDevice();
    expect(await vaultExists()).toBe(false);
  });
});

describe("changing the pin", () => {
  it("re-wraps the phrase under the new pin", async () => {
    await createVault(PHRASE, PIN);
    await changePin(PIN, "987654321");
    expect(await unlockVault("987654321")).toBe(PHRASE);
    await expect(unlockVault(PIN)).rejects.toThrow(WrongPinError);
  }, 15_000);

  it("refuses without the current pin", async () => {
    await createVault(PHRASE, PIN);
    await expect(changePin("1234567", "987654321")).rejects.toThrow(WrongPinError);
    expect(await unlockVault(PIN)).toBe(PHRASE);
  });
});

describe("encrypted device transfer", () => {
  it("moves the existing encrypted vault without putting the phrase in the transfer QR payload", async () => {
    await createVault(PHRASE, PIN);
    const transfer = await exportVaultTransfer();
    expect(transfer).toMatch(/^timber-vault\/v1:/);
    for (const word of PHRASE.split(" ")) expect(transfer).not.toContain(word);
    await wipeDevice();
    await importVaultTransfer(transfer);
    await expect(unlockVault(PIN)).resolves.toBe(PHRASE);
  });

  it("rejects a malformed or altered transfer package", async () => {
    await expect(importVaultTransfer("timber-vault/v1:not-base64")).rejects.toThrow(/transfer/i);
  });
});

describe("an account with no PIN yet", () => {
  it("opens without a PIN and reports itself as unsecured", async () => {
    await createDeviceVault(PHRASE);
    expect(await vaultExists()).toBe(true);
    expect(await vaultKind()).toBe("device");
    expect(await isVaultSecured()).toBe(false);
    expect(await openDeviceVault()).toBe(PHRASE);
  });

  // The whole reason deferring the phrase is safe. An unsecured account has no
  // PIN to get wrong, so the attempt counter and the erase path are unreachable
  // and there is no way to strand someone who has not written anything down.
  it("can never be erased by failed attempts", async () => {
    await createDeviceVault(PHRASE);
    for (let attempt = 0; attempt < MAX_ATTEMPTS * 2; attempt += 1) {
      await expect(unlockVault("000000")).resolves.toBe(PHRASE);
    }
    expect(await vaultExists()).toBe(true);
    expect(await attemptsRemaining()).toBe(MAX_ATTEMPTS);
    expect(await eraseOnFailureEnabled()).toBe(false);
  });

  it("becomes secured once a PIN is set, and keeps the same phrase", async () => {
    await createDeviceVault(PHRASE);
    await secureVaultWithPin(PIN);
    expect(await vaultKind()).toBe("pin");
    expect(await isVaultSecured()).toBe(true);
    expect(await unlockVault(PIN)).toBe(PHRASE);
  });

  it("refuses to set a PIN when there is no unsecured vault to secure", async () => {
    await createVault(PHRASE, PIN);
    await expect(secureVaultWithPin("87654321")).rejects.toThrow(/unsecured/i);
  });

  it("cannot be transferred until it has a PIN to protect the package", async () => {
    await createDeviceVault(PHRASE);
    await expect(exportVaultTransfer()).rejects.toThrow(/set a pin/i);
  });
});

describe("forgetting a PIN", () => {
  it("refuses the PIN rather than erasing once the budget is spent", async () => {
    await createVault(PHRASE, PIN);
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await expect(unlockVault("000000")).rejects.toThrow(WrongPinError);
    }
    await expect(unlockVault("000000")).rejects.toThrow(VaultLockedError);
    // Nothing was destroyed, and the correct PIN is refused too -- the phrase
    // is now the only way back in.
    expect(await vaultExists()).toBe(true);
    await expect(unlockVault(PIN)).rejects.toThrow(VaultLockedError);
  });

  /**
   * The promise the whole recovery model rests on.
   *
   * `identityFromSeed` derives the local database key from the seed and not
   * from the PIN, so re-wrapping under a new PIN leaves every stored message
   * readable. If a refactor ever moves the local key onto the PIN, this test is
   * what catches it -- the symptom in production would be silent, total loss of
   * local history for anyone who reset a PIN.
   */
  it("restores access with the phrase without changing the local database key", async () => {
    await createVault(PHRASE, PIN);
    const before = deriveIdentity(PHRASE);

    await resetPinWithPhrase(PHRASE, "24681012");

    const recovered = await unlockVault("24681012");
    expect(recovered).toBe(PHRASE);
    const after = deriveIdentity(recovered);
    expect([...after.localDbKey]).toEqual([...before.localDbKey]);
    expect(after.userId).toBe(before.userId);
  });

  it("clears a spent attempt budget", async () => {
    await createVault(PHRASE, PIN);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await expect(unlockVault("000000")).rejects.toThrow();
    }
    await resetPinWithPhrase(PHRASE, "24681012");
    expect(await attemptsRemaining()).toBe(MAX_ATTEMPTS);
    await expect(unlockVault("24681012")).resolves.toBe(PHRASE);
  });

  // A vault written before identities were recorded cannot be checked, so the
  // first reset is taken on trust -- but it records the id, which is what makes
  // every later reset on that device checkable.
  it("records the account id when recovering a vault that never stored one", async () => {
    await createVault(PHRASE, PIN);
    await forgetVaultIdentity();
    expect(await vaultIdentity()).toBeNull();

    await resetPinWithPhrase(PHRASE, "24681012");

    expect(await vaultIdentity()).toMatchObject({ userId: deriveIdentity(PHRASE).userId });
    await expect(resetPinWithPhrase(createMnemonic(), "13579111"))
      .rejects.toThrow(PhraseMismatchError);
  });

  // Resetting with someone else's phrase would succeed cryptographically and
  // then leave this device's history sealed under a seed nobody holds.
  it("refuses a valid phrase belonging to a different account", async () => {
    const mine = deriveIdentity(PHRASE);
    await createVault(PHRASE, PIN);
    await setVaultIdentity({ userId: mine.userId, username: "alice" });

    await expect(resetPinWithPhrase(createMnemonic(), "24681012"))
      .rejects.toThrow(PhraseMismatchError);
    await expect(unlockVault(PIN)).resolves.toBe(PHRASE);
  });
});

describe("device recognition", () => {
  it("reads back the owner without unlocking anything", async () => {
    await createDeviceVault(PHRASE, { userId: "u-1", username: "alice", level: 4 });
    expect(await vaultIdentity()).toMatchObject({ username: "alice", level: 4 });
  });

  it("survives setting, changing and resetting a PIN", async () => {
    // The real derived id, because resetting checks the phrase against it.
    const { userId } = deriveIdentity(PHRASE);
    await createDeviceVault(PHRASE, { userId, username: "alice" });
    await secureVaultWithPin(PIN);
    expect(await vaultIdentity()).toMatchObject({ username: "alice" });

    await changePin(PIN, "87654321");
    expect(await vaultIdentity()).toMatchObject({ username: "alice" });

    await resetPinWithPhrase(PHRASE, "24681012");
    expect(await vaultIdentity()).toMatchObject({ username: "alice" });
  });

  it("can be forgotten again, restoring an anonymous lock screen", async () => {
    await createVault(PHRASE, PIN);
    await setVaultIdentity({ userId: "u-1", username: "alice" });
    await forgetVaultIdentity();
    expect(await vaultIdentity()).toBeNull();
    // Forgetting the name must not cost the account.
    await expect(unlockVault(PIN)).resolves.toBe(PHRASE);
  });

  it("travels with a device transfer", async () => {
    await createVault(PHRASE, PIN);
    await setVaultIdentity({ userId: "u-1", username: "alice", level: 7 });
    const transfer = await exportVaultTransfer();

    await wipeDevice();
    await importVaultTransfer(transfer);
    expect(await vaultIdentity()).toMatchObject({ username: "alice", level: 7 });
    await expect(unlockVault(PIN)).resolves.toBe(PHRASE);
  });
});
