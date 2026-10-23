import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
vi.mock("../../crypto/vault.js", () => ({ isVaultSecured: vi.fn() }));
import { isVaultSecured } from "../../crypto/vault.js";
import { useChatStore } from "../../store/chatStore.js";
import SecurePrompt from "./SecurePrompt.jsx";

beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); useChatStore.getState().reset(); isVaultSecured.mockResolvedValue(false); });
afterEach(() => { useChatStore.getState().reset(); });

describe("automatic account backup reminders", () => {
  it("does not prompt anonymous accounts even after they start chatting", () => {
    useChatStore.getState().setMe({ is_anonymous: true });
    render(<SecurePrompt conversationCount={3} onStart={vi.fn()} />);
    expect(screen.queryByText("Back up your account")).not.toBeInTheDocument();
    expect(isVaultSecured).not.toHaveBeenCalled();
  });

  it("offers a standard account a backup and removes it on an anonymous account change", async () => {
    useChatStore.getState().setMe({ is_anonymous: false });
    render(<SecurePrompt conversationCount={1} onStart={vi.fn()} />);
    expect(await screen.findByText("Back up your account")).toBeInTheDocument();
    act(() => useChatStore.getState().setMe({ is_anonymous: true }));
    expect(screen.queryByText("Back up your account")).not.toBeInTheDocument();
  });
});
