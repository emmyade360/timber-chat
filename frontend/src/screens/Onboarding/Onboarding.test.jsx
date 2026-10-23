import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
vi.mock("../../crypto/registration.js", () => ({ pendingRegistration: vi.fn() }));
vi.mock("../../lib/registration.js", () => ({ completeRegistration: vi.fn() }));
vi.mock("../../lib/lockSession.js", () => ({ beginSession: vi.fn() }));
vi.mock("../../lib/auth.js", () => ({ hasAccount: vi.fn(), signIn: vi.fn() }));
vi.mock("../../lib/api.js", () => ({ WAKING_MESSAGE: "Waking…", inviteCodeFromUrl: () => null, lookupInvite: vi.fn() }));
import { pendingRegistration } from "../../crypto/registration.js";
import { completeRegistration } from "../../lib/registration.js";
import { beginSession } from "../../lib/lockSession.js";
import Onboarding from "./Onboarding.jsx";

beforeEach(() => { vi.resetAllMocks(); pendingRegistration.mockResolvedValue(null); });

describe("anonymous onboarding", () => {
  it("asks for a username, explains device loss, and enters without backup or a PIN", async () => {
    const user = userEvent.setup();
    const ready = vi.fn();
    completeRegistration.mockResolvedValue({ mnemonic: "device-secret", created: true });
    render(<Onboarding onReady={ready} />);
    await user.click(await screen.findByRole("button", { name: /Continue anonymously/ }));
    expect(screen.getByText(/Clearing browser data or losing this device/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Username"), "Quiet_Fox");
    await user.click(screen.getByRole("button", { name: "Create anonymous account" }));
    await waitFor(() => expect(ready).toHaveBeenCalledWith({ newAccount: true }));
    expect(completeRegistration).toHaveBeenCalledWith(expect.objectContaining({ username: "quiet_fox", isAnonymous: true }));
    expect(beginSession).toHaveBeenCalledWith("device-secret");
    expect(screen.queryByText("Confirm your phrase")).not.toBeInTheDocument();
  });

  it("resumes the saved pending username and privacy choice after reload", async () => {
    pendingRegistration.mockResolvedValue({ mnemonic: "saved-secret", username: "saved_alias", isAnonymous: true, inviteCode: null });
    render(<Onboarding onReady={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Your anonymous username" })).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toHaveValue("saved_alias");
  });
});
