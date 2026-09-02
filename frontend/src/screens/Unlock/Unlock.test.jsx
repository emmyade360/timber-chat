// The lock screen must never make local history depend on a remote service.
//
// Timber is local-first and end-to-end encrypted: the PIN opens the vault and
// the phrase derives the keys, both entirely on device. Signing in buys access
// to the *relay*, not to the messages already decrypted here. The relay runs on
// a tier that suspends after inactivity, so a sign-in that blocked entry meant a
// sleeping server could lock someone out of their own conversations.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const unlockVault = vi.fn();
const attemptsRemaining = vi.fn(async () => 10);
const vaultIdentity = vi.fn(async () => null);
const resetPinWithPhrase = vi.fn(async () => {});
const beginSession = vi.fn(async () => {});
const signIn = vi.fn(async () => ({}));
const startSessionRecovery = vi.fn();

// Twelve words, because the Continue button genuinely checks the count.
const PHRASE = "one two three four five six seven eight nine ten eleven twelve";

class WrongPinError extends Error {
  constructor(remaining) {
    super(`Incorrect PIN. ${remaining} attempts remaining.`);
    this.name = "WrongPinError";
    this.remaining = remaining;
  }
}
class VaultWipedError extends Error {
  constructor() {
    super("Too many incorrect PIN attempts.");
    this.name = "VaultWipedError";
  }
}
class VaultLockedError extends Error {
  constructor() {
    super("Too many incorrect attempts. Use your twelve-word phrase to set a new PIN.");
    this.name = "VaultLockedError";
  }
}
class PhraseMismatchError extends Error {
  constructor() {
    super("That phrase belongs to a different account.");
    this.name = "PhraseMismatchError";
  }
}

vi.mock("../../crypto/vault.js", () => ({
  MAX_ATTEMPTS: 10,
  MIN_PIN_LENGTH: 6,
  MIN_PASSPHRASE_LENGTH: 8,
  MAX_PIN_LENGTH: 64,
  WrongPinError,
  VaultWipedError,
  VaultLockedError,
  PhraseMismatchError,
  isValidPin: (value) => typeof value === "string" && value.length >= 6,
  unlockVault: (pin) => unlockVault(pin),
  attemptsRemaining: () => attemptsRemaining(),
  vaultIdentity: () => vaultIdentity(),
  resetPinWithPhrase: (phrase, pin) => resetPinWithPhrase(phrase, pin),
  openDeviceVault: vi.fn(async () => "twelve words go here"),
  secureVaultWithPin: vi.fn(async () => {}),
  wipeDevice: vi.fn(async () => {}),
}));
vi.mock("../../crypto/identity.js", () => ({
  deriveIdentity: () => ({ userId: "u1" }),
  normalizeMnemonic: (value) => String(value).trim().replace(/\s+/g, " "),
  isValidMnemonic: () => true,
  unknownWords: () => [],
}));
vi.mock("../../lib/lockSession.js", () => ({ beginSession: (m) => beginSession(m) }));
vi.mock("../../lib/auth.js", () => ({ signIn: (i) => signIn(i) }));
vi.mock("../../lib/sessionRecovery.js", () => ({
  startSessionRecovery: () => startSessionRecovery(),
}));
vi.mock("../../components/Level/LevelBadge.jsx", () => ({ default: () => null }));

const Unlock = (await import("./Unlock.jsx")).default;

const enterPin = async (user, pin = "12345678") => {
  await user.type(screen.getByLabelText("Enter your PIN"), pin);
  await user.click(screen.getByRole("button", { name: "Unlock" }));
};

beforeEach(() => {
  vi.clearAllMocks();
  unlockVault.mockResolvedValue("twelve words go here");
  attemptsRemaining.mockResolvedValue(10);
  vaultIdentity.mockResolvedValue(null);
  resetPinWithPhrase.mockResolvedValue(undefined);
  signIn.mockResolvedValue({});
});

describe("unlocking", () => {
  it("enters the app when the PIN is right", async () => {
    const onUnlocked = vi.fn();
    const user = userEvent.setup();
    render(<Unlock onUnlocked={onUnlocked} onWiped={vi.fn()} />);
    await enterPin(user);
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
  });

  it("enters the app even when the relay is asleep", async () => {
    const onUnlocked = vi.fn();
    signIn.mockRejectedValue(new Error("Timber is taking too long to respond."));
    const user = userEvent.setup();
    render(<Unlock onUnlocked={onUnlocked} onWiped={vi.fn()} />);
    await enterPin(user);

    // The whole point: local history is reachable without the relay.
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled());
    expect(beginSession).toHaveBeenCalled();
    expect(screen.queryByText(/taking too long/i)).not.toBeInTheDocument();
  });

  it("keeps trying to reach the relay after opening offline", async () => {
    signIn.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<Unlock onUnlocked={vi.fn()} onWiped={vi.fn()} />);
    await enterPin(user);
    // Otherwise "opened offline" would mean offline until the page reloads.
    await waitFor(() => expect(startSessionRecovery).toHaveBeenCalled());
  });

  it("opens the session before contacting the relay", async () => {
    const user = userEvent.setup();
    render(<Unlock onUnlocked={vi.fn()} onWiped={vi.fn()} />);
    await enterPin(user);
    await waitFor(() => expect(signIn).toHaveBeenCalled());
    expect(beginSession.mock.invocationCallOrder[0])
      .toBeLessThan(signIn.mock.invocationCallOrder[0]);
  });
});

describe("failed unlocking", () => {
  it("clears the PIN when the PIN was wrong", async () => {
    unlockVault.mockRejectedValue(new WrongPinError(9));
    attemptsRemaining.mockResolvedValue(9);
    const user = userEvent.setup();
    render(<Unlock onUnlocked={vi.fn()} onWiped={vi.fn()} />);
    await enterPin(user);
    await waitFor(() => expect(screen.getByText(/Incorrect PIN/)).toBeInTheDocument());
    expect(screen.getByLabelText("Enter your PIN")).toHaveValue("");
  });

  it("keeps the typed PIN when the failure was not the PIN", async () => {
    // Retyping a PIN because the storage layer hiccuped is pure punishment.
    unlockVault.mockRejectedValue(new Error("Database is blocked by another tab."));
    const user = userEvent.setup();
    render(<Unlock onUnlocked={vi.fn()} onWiped={vi.fn()} />);
    await enterPin(user, "87654321");
    await waitFor(() => expect(screen.getByText(/another tab/)).toBeInTheDocument());
    expect(screen.getByLabelText("Enter your PIN")).toHaveValue("87654321");
  });

  it("reports a wiped device instead of an error", async () => {
    const onWiped = vi.fn();
    unlockVault.mockRejectedValue(new VaultWipedError());
    const user = userEvent.setup();
    render(<Unlock onUnlocked={vi.fn()} onWiped={onWiped} />);
    await enterPin(user);
    await waitFor(() => expect(onWiped).toHaveBeenCalledWith("Too many incorrect PIN attempts."));
  });
});

describe("recognising the device owner", () => {
  it("greets the account this device belongs to", async () => {
    vaultIdentity.mockResolvedValue({
      userId: "u1",
      username: "alice",
      levelName: "Cedar",
      level: 6,
    });
    render(<Unlock onUnlocked={() => {}} onWiped={() => {}} />);
    expect(await screen.findByText("@alice")).toBeInTheDocument();
    expect(screen.getByText(/Cedar/)).toBeInTheDocument();
  });

  it("falls back to an anonymous card when recognition is off", async () => {
    vaultIdentity.mockResolvedValue(null);
    render(<Unlock onUnlocked={() => {}} onWiped={() => {}} />);
    expect(await screen.findByText("Timber")).toBeInTheDocument();
    expect(screen.queryByText(/^@/)).not.toBeInTheDocument();
  });
});

describe("forgetting the PIN", () => {
  // The point of the whole path: no wipe, and the session opens normally
  // afterwards, so local history is still there on the other side.
  it("sets a new PIN from the phrase and enters without erasing anything", async () => {
    const user = userEvent.setup();
    const onUnlocked = vi.fn();
    const onWiped = vi.fn();
    render(<Unlock onUnlocked={onUnlocked} onWiped={onWiped} />);

    await user.click(await screen.findByRole("button", { name: "Forgot your PIN?" }));
    await user.type(screen.getByPlaceholderText(/oak sprout cedar/), PHRASE);
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await user.type(screen.getByLabelText(/^PIN/), "246810");
    await user.type(screen.getByLabelText("Confirm PIN"), "246810");
    await user.click(screen.getByRole("button", { name: "Protect my account" }));

    await waitFor(() => expect(resetPinWithPhrase).toHaveBeenCalledWith(PHRASE, "246810"));
    expect(onUnlocked).toHaveBeenCalled();
    expect(onWiped).not.toHaveBeenCalled();
  });

  it("offers recovery instead of a wipe once the attempt budget is spent", async () => {
    const user = userEvent.setup();
    const onWiped = vi.fn();
    unlockVault.mockRejectedValue(new VaultLockedError());
    attemptsRemaining.mockResolvedValue(0);
    render(<Unlock onUnlocked={() => {}} onWiped={onWiped} />);

    await user.click(await screen.findByRole("button", { name: "Forgot your PIN?" }));
    expect(screen.getByText(/Reset your PIN/)).toBeInTheDocument();
    expect(onWiped).not.toHaveBeenCalled();
  });

  it("reports a phrase that belongs to a different account", async () => {
    const user = userEvent.setup();
    resetPinWithPhrase.mockRejectedValue(new PhraseMismatchError());
    render(<Unlock onUnlocked={() => {}} onWiped={() => {}} />);

    await user.click(await screen.findByRole("button", { name: "Forgot your PIN?" }));
    await user.type(screen.getByPlaceholderText(/oak sprout cedar/), PHRASE);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByLabelText(/^PIN/), "246810");
    await user.type(screen.getByLabelText("Confirm PIN"), "246810");
    await user.click(screen.getByRole("button", { name: "Protect my account" }));

    expect(await screen.findByText(/different account/i)).toBeInTheDocument();
  });
});
