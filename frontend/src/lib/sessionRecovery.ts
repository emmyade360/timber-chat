// Getting a relay session after the app opened without one.
//
// Timber is local-first: the PIN decrypts everything this device already holds,
// so a sleeping relay must never keep someone out of their own history. Unlock
// therefore enters the app immediately and signs in behind it.
//
// That leaves one gap, which this closes. Nothing else retries a *missing*
// session: the 401 interceptor in api.js only refreshes a token that already
// exists, and the WebSocket gives up without rescheduling when there is no
// token to open a ticket with. Without a retry here, "opened offline" would
// quietly mean "offline until the page is reloaded".

import { getToken } from "./api.js";
import { signIn } from "./auth.js";
import { currentIdentity, isUnlocked } from "../crypto/session.js";

/**
 * Backoff for a cold free-tier instance. The first few probes are close
 * together because a relay that is merely slow answers quickly; the tail is
 * long because one that is genuinely asleep takes tens of seconds, and hammering
 * it neither wakes it sooner nor costs nothing.
 */
const DELAYS_MS = [1_000, 3_000, 8_000, 20_000, 45_000] as const;

let timer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let running = false;
let detachOnline: (() => void) | null = null;

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Stop retrying. Called on success, on lock, and on sign-out. */
export function stopSessionRecovery(): void {
  clearTimer();
  detachOnline?.();
  detachOnline = null;
  running = false;
  attempt = 0;
}

async function tryOnce(): Promise<void> {
  // Someone else may have signed in first -- a resumed session, or a 401
  // refresh that raced us. Either way there is nothing left to recover.
  if (!isUnlocked() || getToken()) {
    stopSessionRecovery();
    return;
  }
  try {
    await signIn(currentIdentity());
    stopSessionRecovery();
  } catch {
    schedule();
  }
}

function schedule(): void {
  if (!running) return;
  clearTimer();
  const delay = DELAYS_MS[Math.min(attempt, DELAYS_MS.length - 1)] ?? 45_000;
  attempt += 1;
  timer = setTimeout(() => { void tryOnce(); }, delay);
}

/**
 * Begin recovering a relay session in the background.
 *
 * Safe to call repeatedly; only the first call starts a loop. Returns
 * immediately -- nothing waits on this, which is the entire point.
 */
export function startSessionRecovery(): void {
  if (running || !isUnlocked() || getToken()) return;
  running = true;
  attempt = 0;

  // Coming back online is a much better signal than any timer, so take it and
  // reset the backoff rather than sitting out the rest of a long delay.
  if (typeof window !== "undefined") {
    const onOnline = () => {
      if (!running) return;
      attempt = 0;
      clearTimer();
      void tryOnce();
    };
    window.addEventListener("online", onOnline);
    detachOnline = () => { window.removeEventListener("online", onOnline); };
  }

  schedule();
}

/** Testing seam: whether a recovery loop is currently armed. */
export function isRecovering(): boolean {
  return running;
}
