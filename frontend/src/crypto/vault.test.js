import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_ATTEMPTS,
  MIN_PIN_LENGTH,
  VaultWipedError,
  WrongPinError,
  attemptsRemaining,
  changePin,
  createVault,
  exportVaultTransfer,
  importVaultTransfer,
  isValidPin,
  unlockVault,
  vaultExists,
  wipeDevice,
} from "./vault.js";
import { createMnemonic } from "./identity.js";

const PHRASE = createMnemonic();
const PIN = "31415926";

beforeEach(async () => {
  await wipeDevice();
});

describe("pin policy", () => {
  it("enforces a minimum length", () => {
    expect(isValidPin("1".repeat(MIN_PIN_LENGTH))).toBe(true);
    expect(isValidPin("1".repeat(MIN_PIN_LENGTH - 1))).toBe(false);
    expect(isValidPin("passphrase")).toBe(false);
    expect(isValidPin("")).toBe(false);
  });

  it("refuses to create a vault with a short pin", async () => {
    await expect(createVault(PHRASE, "123")).rejects.toThrow(/at least/i);
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
  it("wipes the device after the attempt limit and stays wiped", async () => {
    await createVault(PHRASE, PIN);
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
