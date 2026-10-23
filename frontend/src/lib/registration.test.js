import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./auth.js", () => ({ hasAccount: vi.fn(), register: vi.fn(), registerAnonymous: vi.fn(), signIn: vi.fn() }));
import { hasAccount, register, registerAnonymous, signIn } from "./auth.js";
import { createMnemonic } from "../crypto/identity.js";
import { pendingRegistration } from "../crypto/registration.js";
import * as registrationStorage from "../crypto/registration.js";
import { openDeviceVault, vaultExists, vaultIdentity, vaultPrivacy, wipeDevice } from "../crypto/vault.js";
import { completeRegistration } from "./registration.js";

const draft = () => ({ mnemonic: createMnemonic(), username: "quiet_fox", isAnonymous: true, inviteCode: "INVITE22" });
const account = (identity, username = "quiet_fox", anonymous = true) => ({ user_id: identity.userId, username, is_anonymous: anonymous });
beforeEach(async () => { vi.restoreAllMocks(); vi.resetAllMocks(); await wipeDevice(); });

describe("signup completion", () => {
  it("uses anonymous registration and forwards the chosen name and invitation", async () => {
    const input = draft();
    hasAccount.mockResolvedValue(false);
    registerAnonymous.mockImplementation(async (identity) => account(identity));
    await completeRegistration(input);
    expect(registerAnonymous).toHaveBeenCalledWith(expect.anything(), input.username, input.inviteCode);
    expect(register).not.toHaveBeenCalled();
    expect(await openDeviceVault()).toBe(input.mnemonic);
    expect(await vaultPrivacy()).toBe(true);
  });

  it("keeps standard signup on the original endpoint", async () => {
    hasAccount.mockResolvedValue(false);
    register.mockImplementation(async (identity) => account(identity, "quiet_fox", false));
    await completeRegistration({ ...draft(), isAnonymous: false });
    expect(register).toHaveBeenCalledOnce();
    expect(registerAnonymous).not.toHaveBeenCalled();
    expect(await vaultPrivacy()).toBe(false);
  });

  it("logs into the same identity after the registration response is lost", async () => {
    const input = draft();
    hasAccount.mockResolvedValueOnce(false).mockResolvedValue(true);
    registerAnonymous.mockRejectedValue(new Error("response lost"));
    signIn.mockImplementation(async (identity) => account(identity, "actual_name"));
    await completeRegistration(input);
    expect(registerAnonymous).toHaveBeenCalledOnce();
    expect(signIn).toHaveBeenCalledOnce();
    expect((await vaultIdentity()).username).toBe("actual_name");
    expect(await openDeviceVault()).toBe(input.mnemonic);
  });

  it("resumes saved keys after a failed username submission", async () => {
    hasAccount.mockResolvedValue(false);
    registerAnonymous.mockRejectedValueOnce(new Error("That username is already taken."))
      .mockImplementation(async (identity, username) => account(identity, username));
    const input = draft();
    await expect(completeRegistration(input)).rejects.toThrow(/already taken/);
    const pending = await pendingRegistration();
    await completeRegistration({ ...pending, username: "new_username" });
    expect(await openDeviceVault()).toBe(input.mnemonic);
    expect((await vaultIdentity()).username).toBe("new_username");
  });

  it("deduplicates concurrent submissions", async () => {
    hasAccount.mockResolvedValue(false);
    registerAnonymous.mockImplementation(async (identity) => account(identity));
    const first = completeRegistration(draft());
    const second = completeRegistration(draft());
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(registerAnonymous).toHaveBeenCalledOnce();
  });

  it("does not contact the server if local staging fails", async () => {
    vi.spyOn(registrationStorage, "stageRegistration").mockRejectedValue(new Error("storage blocked"));
    await expect(completeRegistration(draft())).rejects.toThrow(/storage blocked/);
    expect(hasAccount).not.toHaveBeenCalled();
    expect(registerAnonymous).not.toHaveBeenCalled();
  });

  it("keeps pending keys if promotion fails after the server creates the account", async () => {
    const input = draft();
    hasAccount.mockResolvedValueOnce(false).mockResolvedValue(true);
    registerAnonymous.mockImplementation(async (identity) => account(identity));
    signIn.mockImplementation(async (identity) => account(identity, "quiet_fox"));
    vi.spyOn(registrationStorage, "finishRegistration").mockRejectedValueOnce(new Error("storage quota exceeded"));
    await expect(completeRegistration(input)).rejects.toThrow(/storage quota/);
    expect(await vaultExists()).toBe(false);
    const pending = await pendingRegistration();
    expect(pending.mnemonic).toBe(input.mnemonic);
    await completeRegistration({ ...pending, username: "edited_after_interruption" });
    expect(registerAnonymous).toHaveBeenCalledOnce();
    expect(signIn).toHaveBeenCalledOnce();
    expect(await openDeviceVault()).toBe(input.mnemonic);
    expect((await vaultIdentity()).username).toBe("quiet_fox");
    expect(await pendingRegistration()).toBeNull();
  });

  it("keeps a completed account when persistent-storage permission is denied", async () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, "storage");
    const persist = vi.fn().mockRejectedValue(new Error("permission denied"));
    Object.defineProperty(navigator, "storage", { configurable: true, value: { persist } });
    try {
      hasAccount.mockResolvedValue(false);
      registerAnonymous.mockImplementation(async (identity) => account(identity));
      const result = await completeRegistration(draft());
      expect(persist).toHaveBeenCalledOnce();
      expect(await openDeviceVault()).toBe(result.mnemonic);
    } finally {
      if (previous) Object.defineProperty(navigator, "storage", previous);
      else delete navigator.storage;
    }
  });
});
