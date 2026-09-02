// Contract tests for the session phase machine.
//
// Today this logic lives inside App.jsx as a `phase` useState plus a boot
// effect, and it has never had a test. It decides whether a person sees
// onboarding, the PIN screen, or the app -- getting it wrong either locks
// someone out of their own vault or shows an unlocked shell to a locked one.
//
// These tests are written against observable behaviour, not structure, so they
// survive the extraction of `SessionGate` unchanged. That is the point: they
// are the net under that refactor.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const vaultExists = vi.fn();
const isUnlocked = vi.fn();
const sessionOpenedAt = vi.fn(() => 0);
const closeSession = vi.fn();
const restoreSession = vi.fn();
const endSession = vi.fn(() => Promise.resolve());
const runtimeConfigurationError = vi.fn(() => "");
const getToken = vi.fn(() => null);
const logout = vi.fn(() => Promise.resolve());
const clearToken = vi.fn();
const disablePushAlerts = vi.fn(() => Promise.resolve());
const consumePendingTarget = vi.fn(() => null);

vi.mock("../crypto/vault.js", () => ({ vaultExists: () => vaultExists() }));
vi.mock("../crypto/session.js", () => ({
  isUnlocked: () => isUnlocked(),
  sessionOpenedAt: () => sessionOpenedAt(),
  closeSession: () => closeSession(),
}));
vi.mock("../lib/lockSession.js", () => ({
  restoreSession: () => restoreSession(),
  endSession: () => endSession(),
}));
vi.mock("../lib/api.js", () => ({
  runtimeConfigurationError: () => runtimeConfigurationError(),
  getToken: () => getToken(),
  logout: () => logout(),
  clearToken: () => clearToken(),
  userMessage: (_error, fallback) => fallback,
}));
vi.mock("../lib/push.js", () => ({
  disablePushAlerts: () => disablePushAlerts(),
  ensurePushSubscription: () => Promise.resolve(),
}));
const bootstrap = vi.fn(() => Promise.resolve());
vi.mock("../lib/sync.js", () => ({
  bootstrap: () => bootstrap(),
  reconcileRealtime: () => Promise.resolve([]),
}));
vi.mock("../lib/deepLink.js", () => ({
  consumePendingTarget: () => consumePendingTarget(),
  subscribePendingTarget: () => () => {},
}));
vi.mock("../lib/notifications.js", () => ({
  subscribeIncomingNotification: () => () => {},
}));

// The hooks the shell needs in order to mount at all. None of them are the
// subject here; they are stubbed to their quiescent shape.
vi.mock("../hooks/useWebSocket.js", () => {
  // One stable object, as the real hook returns. Handing back a fresh object
  // per render would retrigger every effect that depends on it.
  const socket = { send: vi.fn(), connected: true, acknowledge: vi.fn(), subscribe: () => () => {} };
  return { useWebSocket: () => socket };
});
vi.mock("../hooks/useCall.js", () => {
  // `resumePendingCalls` is a useCallback in the real hook and is a dependency
  // of the pending-target effect, so its identity has to be stable here too.
  const controller = {
    call: { phase: "idle" },
    startCall: vi.fn(),
    acceptCall: vi.fn(),
    endCall: vi.fn(),
    toggleMuted: vi.fn(),
    toggleCamera: vi.fn(),
    dismissNotice: vi.fn(),
    resumePendingCalls: () => Promise.resolve(),
  };
  return { useCall: () => controller };
});
vi.mock("../hooks/usePwaInstall.js", () => {
  const pwa = {
    canInstall: false, installed: false, isIos: false,
    promptInstall: vi.fn(), justInstalled: false, acknowledgeInstalled: vi.fn(),
  };
  return { usePwaInstall: () => pwa };
});
vi.mock("../hooks/useCalmCheckIns.js", () => ({ useCalmCheckIns: () => {} }));
vi.mock("../hooks/useAutoLock.js", () => ({ useAutoLock: () => {} }));

// The screens are placeholders: which one renders is the contract, what it
// renders is each screen's own business.
vi.mock("../screens/Onboarding/Onboarding.jsx", () => ({
  default: ({ onReady }) => (
    <div>
      <p>onboarding-screen</p>
      <button onClick={() => onReady({ newAccount: true })}>finish-onboarding</button>
    </div>
  ),
}));
vi.mock("../screens/Unlock/Unlock.jsx", () => ({
  default: ({ onUnlocked, onWiped }) => (
    <div>
      <p>unlock-screen</p>
      <button onClick={() => onUnlocked({})}>finish-unlock</button>
      <button onClick={() => onWiped("This device was wiped.")}>wipe-device</button>
    </div>
  ),
}));
vi.mock("../screens/Chats/Chats.jsx", () => ({ default: () => <p>chats-screen</p> }));
vi.mock("../screens/Chat/Chat.jsx", () => ({ default: () => <p>chat-screen</p> }));
vi.mock("../screens/People/People.jsx", () => ({ default: () => <p>people-screen</p> }));
vi.mock("../screens/Explore/Explore.jsx", () => ({ default: () => <p>explore-screen</p> }));
vi.mock("../screens/Profile/Profile.jsx", () => ({ default: () => <p>profile-screen</p> }));
vi.mock("../screens/Me/Me.jsx", () => ({ default: () => <p>settings-screen</p> }));
vi.mock("../screens/Vault/Vault.jsx", () => ({ default: () => <p>vault-screen</p> }));
vi.mock("../components/Call/CallOverlay.jsx", () => ({ default: () => null }));
vi.mock("../components/Install/InstallTimberPrompt.jsx", () => ({ default: () => null }));

const { useChatStore } = await import("../store/chatStore.js");
const App = (await import("../App.jsx")).default;

beforeEach(() => {
  bootstrap.mockResolvedValue(undefined);
  useChatStore.getState().reset();
  vaultExists.mockResolvedValue(true);
  isUnlocked.mockReturnValue(false);
  restoreSession.mockResolvedValue(false);
  runtimeConfigurationError.mockReturnValue("");
  consumePendingTarget.mockReturnValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("session phase machine", () => {
  it("shows onboarding when this device holds no vault", async () => {
    vaultExists.mockResolvedValue(false);
    render(<App />);
    expect(await screen.findByText("onboarding-screen")).toBeInTheDocument();
  });

  it("shows the PIN screen when a vault exists but the session cannot resume", async () => {
    restoreSession.mockResolvedValue(false);
    render(<App />);
    expect(await screen.findByText("unlock-screen")).toBeInTheDocument();
  });

  it("enters the app when the lock policy lets the session resume", async () => {
    restoreSession.mockResolvedValue(true);
    render(<App />);
    expect(await screen.findByText("chats-screen")).toBeInTheDocument();
  });

  it("enters the app without touching storage when keys are already live", async () => {
    isUnlocked.mockReturnValue(true);
    render(<App />);
    expect(await screen.findByText("chats-screen")).toBeInTheDocument();
    // An already-unlocked session must not be asked to restore itself; doing so
    // would consume a resume token that is still in use.
    expect(vaultExists).not.toHaveBeenCalled();
    expect(restoreSession).not.toHaveBeenCalled();
  });

  it("falls back to the PIN screen when boot throws", async () => {
    vaultExists.mockRejectedValue(new Error("indexeddb unavailable"));
    render(<App />);
    expect(await screen.findByText("unlock-screen")).toBeInTheDocument();
  });

  it("refuses to render the app at all when the runtime is misconfigured", async () => {
    runtimeConfigurationError.mockReturnValue("VITE_API_URL is not set");
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Timber is unavailable");
    expect(alert).toHaveTextContent("VITE_API_URL is not set");
    expect(screen.queryByText("chats-screen")).not.toBeInTheDocument();
  });
});

describe("session phase transitions", () => {
  it("moves from onboarding into the app once a vault is created", async () => {
    const user = userEvent.setup();
    vaultExists.mockResolvedValue(false);
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "finish-onboarding" }));
    expect(await screen.findByText("chats-screen")).toBeInTheDocument();
  });

  it("moves from the PIN screen into the app once unlocked", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "finish-unlock" }));
    expect(await screen.findByText("chats-screen")).toBeInTheDocument();
  });

  it("returns to onboarding with a notice after a device wipe", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "wipe-device" }));
    expect(await screen.findByText("onboarding-screen")).toBeInTheDocument();
    expect(screen.getByText("This device was wiped.")).toBeInTheDocument();
  });

  it("drops the push subscription before clearing the token on a wipe", async () => {
    const user = userEvent.setup();
    getToken.mockReturnValue("a-token");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "wipe-device" }));
    await waitFor(() => expect(clearToken).toHaveBeenCalled());
    // Order matters: clearing the token first would leave the endpoint
    // registered on the relay with no way left to revoke it.
    expect(disablePushAlerts).toHaveBeenCalled();
    expect(disablePushAlerts.mock.invocationCallOrder[0])
      .toBeLessThan(clearToken.mock.invocationCallOrder[0]);
  });
});

// ---------------------------------------------------------------------------
// Navigation reachability.
//
// Today every destination is component state in `Shell`: `tab`, `chatsPage`,
// `vaultPage`, `settingsOpen`, `openConversation`. Phase 3 replaces all of it
// with routes. These tests name the destinations and the rules for reaching
// them, so the router has something concrete to satisfy rather than "it looked
// the same when I clicked around".
// ---------------------------------------------------------------------------

const sections = () => within(screen.getByRole("navigation", { name: "Sections" }));

const enterApp = async () => {
  isUnlocked.mockReturnValue(true);
  render(<App />);
  return screen.findByText("chats-screen");
};

describe("shell navigation", () => {
  it("opens on the chat list", async () => {
    await enterApp();
    expect(screen.getByText("chats-screen")).toBeInTheDocument();
  });

  it("reaches the vault and the profile from the section bar", async () => {
    const user = userEvent.setup();
    await enterApp();

    await user.click(sections().getByRole("button", { name: /vault/i }));
    expect(await screen.findByText("vault-screen")).toBeInTheDocument();

    await user.click(sections().getByRole("button", { name: /profile/i }));
    expect(await screen.findByText("profile-screen")).toBeInTheDocument();

    await user.click(sections().getByRole("button", { name: /chats/i }));
    expect(await screen.findByText("chats-screen")).toBeInTheDocument();
  });

  it("marks the current section for assistive technology", async () => {
    const user = userEvent.setup();
    await enterApp();
    expect(sections().getByRole("button", { name: /chats/i })).toHaveAttribute("aria-current", "page");

    await user.click(sections().getByRole("button", { name: /vault/i }));
    await waitFor(() =>
      expect(sections().getByRole("button", { name: /vault/i })).toHaveAttribute("aria-current", "page"));
    expect(sections().getByRole("button", { name: /chats/i })).not.toHaveAttribute("aria-current");
  });
});

describe("notification targets", () => {
  it("opens the conversation a tapped message notification points at", async () => {
    isUnlocked.mockReturnValue(true);
    consumePendingTarget.mockReturnValueOnce({ kind: "chat", conversationId: "conv-1" });
    render(<App />);
    expect(await screen.findByText("chat-screen")).toBeInTheDocument();
  });

  it("opens the conversation a tapped call notification points at", async () => {
    isUnlocked.mockReturnValue(true);
    consumePendingTarget.mockReturnValueOnce({ kind: "call", conversationId: "conv-1" });
    render(<App />);
    expect(await screen.findByText("chat-screen")).toBeInTheDocument();
  });

  it("lands a friend-request notification on the people list inside the vault", async () => {
    isUnlocked.mockReturnValue(true);
    consumePendingTarget.mockReturnValueOnce({ kind: "people" });
    render(<App />);
    expect(await screen.findByText("people-screen")).toBeInTheDocument();
  });

  it("ignores a target that names no conversation", async () => {
    isUnlocked.mockReturnValue(true);
    consumePendingTarget.mockReturnValueOnce({ kind: "chat" });
    render(<App />);
    expect(await screen.findByText("chats-screen")).toBeInTheDocument();
  });

  it("closes an open conversation when another section is chosen", async () => {
    const user = userEvent.setup();
    isUnlocked.mockReturnValue(true);
    consumePendingTarget.mockReturnValueOnce({ kind: "chat", conversationId: "conv-1" });
    render(<App />);
    await screen.findByText("chat-screen");

    await user.click(sections().getByRole("button", { name: /vault/i }));
    expect(await screen.findByText("vault-screen")).toBeInTheDocument();
    expect(screen.queryByText("chat-screen")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Rules of React: state that two systems share is written once, by whatever
// caused the change -- not synchronised afterwards by an Effect watching it.
// ---------------------------------------------------------------------------

describe("the open conversation", () => {
  it("reaches the store in the same update that opens it", async () => {
    isUnlocked.mockReturnValue(true);
    consumePendingTarget.mockReturnValueOnce({ kind: "chat", conversationId: "conv-7" });
    render(<App />);
    await screen.findByText("chat-screen");

    // Was an Effect chained off the component's own state, which left a render
    // in which the two disagreed about which thread was open.
    await waitFor(() =>
      expect(useChatStore.getState().activeConversationId).toBe("conv-7"));
  });

  it("clears the store when the conversation is closed", async () => {
    const user = userEvent.setup();
    isUnlocked.mockReturnValue(true);
    consumePendingTarget.mockReturnValueOnce({ kind: "chat", conversationId: "conv-7" });
    render(<App />);
    await screen.findByText("chat-screen");

    await user.click(sections().getByRole("button", { name: /vault/i }));
    await waitFor(() =>
      expect(useChatStore.getState().activeConversationId).toBeNull());
  });
});

describe("locking during a sync", () => {
  it("scrubs anything the in-flight sync wrote after the keys were wiped", async () => {
    isUnlocked.mockReturnValue(true);

    // A bootstrap that is still running when the session goes away.
    let finish;
    bootstrap.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { unmount } = render(<App />);
    await screen.findByText("chats-screen");

    // Whatever the sync had written by the time the lock happened.
    useChatStore.getState().setConversations([
      { id: "c1", peerId: "p1", peerUsername: "riverstone" },
    ]);

    // Lock: keys gone, shell torn down, store cleared.
    isUnlocked.mockReturnValue(false);
    unmount();

    finish();
    // Leaving a decrypted peer name in memory is precisely what locking exists
    // to prevent, so a late write has to be swept up rather than left behind.
    await waitFor(() => expect(useChatStore.getState().conversations).toEqual([]));
  });

  it("leaves the store alone when the session is still unlocked", async () => {
    isUnlocked.mockReturnValue(true);
    let finish;
    bootstrap.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { unmount } = render(<App />);
    await screen.findByText("chats-screen");

    useChatStore.getState().setConversations([
      { id: "c1", peerId: "p1", peerUsername: "riverstone" },
    ]);

    // A StrictMode remount tears the Effect down without locking anything, and
    // must not be mistaken for one.
    unmount();
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useChatStore.getState().conversations).toHaveLength(1);
  });
});
