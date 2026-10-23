import { beforeEach, describe, expect, it } from "vitest";
import { createMnemonic, deriveIdentity } from "./identity.js";
import { finishRegistration, pendingRegistration, stageRegistration } from "./registration.js";
import { createDeviceVault, forgetVaultIdentity, openDeviceVault, secureVaultWithPin,
  vaultExists, vaultPrivacy, wipeDevice } from "./vault.js";
import { STORE_VAULT, timberDb } from "../db/timberDb.js";
import { isDeviceVaultRecord, isResumeRecord, isVaultRecord } from "../types/db.js";

const draft = (username = "quiet_fox") => ({ mnemonic: createMnemonic(), username, isAnonymous: true, inviteCode: "INVITE22" });
beforeEach(async () => { await wipeDevice(); });

describe("durable pending signup", () => {
  it("seals signup details without making an active vault or a resume token", async () => {
    const input = draft();
    const pending = await stageRegistration(input);
    const record = await (await timberDb()).get(STORE_VAULT, "pending-registration");
    expect(JSON.stringify(record)).not.toContain(input.mnemonic);
    expect(JSON.stringify(record)).not.toContain(input.username);
    expect(JSON.stringify(record)).not.toContain(input.inviteCode);
    expect(record && "key" in record && record.key.extractable).toBe(false);
    expect(isResumeRecord(record)).toBe(false);
    expect(isVaultRecord(record)).toBe(false);
    expect(isDeviceVaultRecord(record)).toBe(false);
    expect(await vaultExists()).toBe(false);
    expect((await pendingRegistration())?.userId).toBe(pending.userId);
  });

  it("adopts one identity when two tabs stage competing signups", async () => {
    const first = draft();
    const second = draft("other_fox");
    const results = await Promise.all([stageRegistration(first), stageRegistration(second)]);
    expect(results[0]?.userId).toBe(results[1]?.userId);
    expect((await pendingRegistration())?.userId).toBe(results[0]?.userId);
    expect([deriveIdentity(first.mnemonic).userId, deriveIdentity(second.mnemonic).userId]).toContain(results[0]?.userId);
  });

  it("edits a taken username without replacing the pending keys", async () => {
    const pending = await stageRegistration(draft());
    const changed = await stageRegistration({ ...pending, username: "available_fox" });
    expect(changed.userId).toBe(pending.userId);
    expect(changed.username).toBe("available_fox");
    expect(changed.mnemonic).toBe(pending.mnemonic);
    await expect(createDeviceVault(createMnemonic())).rejects.toThrow(/unfinished signup/i);
  });

  it("promotes the same keys and server username, preserving privacy through a PIN", async () => {
    const pending = await stageRegistration(draft());
    await finishRegistration(pending, { user_id: pending.userId, username: "server_name", is_anonymous: true });
    expect(await pendingRegistration()).toBeNull();
    expect(await vaultExists()).toBe(true);
    expect(deriveIdentity(await openDeviceVault()).userId).toBe(pending.userId);
    expect(await vaultPrivacy()).toBe(true);
    await forgetVaultIdentity();
    await secureVaultWithPin("24681357");
    expect(await vaultPrivacy()).toBe(true);
    const record = await (await timberDb()).get(STORE_VAULT, "seed");
    expect(record && "ownerId" in record && record.ownerId).toBe(pending.userId);
  });

  it("keeps pending keys when the response identifies a different account or mode", async () => {
    const pending = await stageRegistration(draft());
    await expect(finishRegistration(pending, { user_id: "different", username: "fox", is_anonymous: true })).rejects.toThrow(/did not match/);
    await expect(finishRegistration(pending, { user_id: pending.userId, username: "fox", is_anonymous: false })).rejects.toThrow(/did not match/);
    expect((await pendingRegistration())?.userId).toBe(pending.userId);
    expect(await vaultExists()).toBe(false);
  });

  it("refuses to overwrite an existing active account", async () => {
    const original = createMnemonic();
    await createDeviceVault(original, undefined, true);
    await expect(stageRegistration(draft())).rejects.toThrow(/already holds an account/);
    await expect(createDeviceVault(createMnemonic())).rejects.toThrow(/already holds an account/);
    expect(await openDeviceVault()).toBe(original);
  });
});
