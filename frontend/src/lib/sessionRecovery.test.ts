// @vitest-environment jsdom
//
// Lives in the node project with the rest of lib/, but the recovery loop listens
// for the browser's `online` event, so this one file needs a window.

// Opening offline has to be a delay, not a dead end.
//
// Nothing else in the app retries a *missing* session: the 401 interceptor only
// refreshes a token that already exists, and the WebSocket returns without
// rescheduling when there is none. These cover the loop that closes that gap.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signIn = vi.fn();
const getToken = vi.fn<() => string | null>(() => null);
const isUnlocked = vi.fn(() => true);

vi.mock("./auth.js", () => ({ signIn: (identity: unknown) => signIn(identity) }));
vi.mock("./api.js", () => ({ getToken: () => getToken() }));
vi.mock("../crypto/session.js", () => ({
  isUnlocked: () => isUnlocked(),
  currentIdentity: () => ({ userId: "u1" }),
}));

const { startSessionRecovery, stopSessionRecovery, isRecovering } =
  await import("./sessionRecovery.js");

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  getToken.mockReturnValue(null);
  isUnlocked.mockReturnValue(true);
  signIn.mockResolvedValue({});
});

afterEach(() => {
  stopSessionRecovery();
  vi.useRealTimers();
});

describe("session recovery", () => {
  it("signs in once the relay answers", async () => {
    signIn.mockRejectedValueOnce(new Error("asleep")).mockResolvedValueOnce({});
    startSessionRecovery();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(signIn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(signIn).toHaveBeenCalledTimes(2);
    expect(isRecovering()).toBe(false);
  });

  it("backs off instead of hammering a waking instance", async () => {
    signIn.mockRejectedValue(new Error("asleep"));
    startSessionRecovery();

    // Delays are 1s, 3s, 8s... so 3s of elapsed time is two attempts, not three.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signIn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(signIn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(signIn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signIn).toHaveBeenCalledTimes(3);
  });

  it("stops when the app is locked", async () => {
    signIn.mockRejectedValue(new Error("asleep"));
    startSessionRecovery();
    await vi.advanceTimersByTimeAsync(1_000);

    isUnlocked.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(60_000);
    // Signing in for a session that no longer exists would re-authenticate a
    // device the user just locked.
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(isRecovering()).toBe(false);
  });

  it("gives up quietly when another path already signed in", async () => {
    signIn.mockRejectedValue(new Error("asleep"));
    startSessionRecovery();
    await vi.advanceTimersByTimeAsync(1_000);

    getToken.mockReturnValue("a-token");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(isRecovering()).toBe(false);
  });

  it("does not start when there is already a session", () => {
    getToken.mockReturnValue("a-token");
    startSessionRecovery();
    expect(isRecovering()).toBe(false);
  });

  it("runs only one loop however many times it is started", async () => {
    signIn.mockRejectedValue(new Error("asleep"));
    startSessionRecovery();
    startSessionRecovery();
    startSessionRecovery();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("retries immediately when the device comes back online", async () => {
    signIn.mockRejectedValue(new Error("asleep"));
    startSessionRecovery();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signIn).toHaveBeenCalledTimes(1);

    // A real connectivity signal beats sitting out the rest of the backoff.
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(signIn).toHaveBeenCalledTimes(2);
  });
});
