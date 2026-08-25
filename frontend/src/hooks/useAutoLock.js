// Locks decrypted material after a short idle period and coordinates every open
// Timber tab. Browser tabs do not share JavaScript memory, so each must wipe its
// own derived keys when one of them is explicitly locked.

import { useEffect, useRef } from "react";
import { LOCK_POLICIES, normalizeLockPolicy } from "../lib/lockPolicy.js";

export const IDLE_LOCK_MS = 5 * 60 * 1000;
export const HIDDEN_LOCK_MS = 30 * 1000;
export const SESSION_LOCK_MS = 2 * 60 * 60 * 1000;

export function useAutoLock(enabled, onLock, policy = LOCK_POLICIES.always) {
  const lockRef = useRef(onLock);

  useEffect(() => {
    lockRef.current = onLock;
  }, [onLock]);

  useEffect(() => {
    if (!enabled) return undefined;
    const selected = normalizeLockPolicy(policy);
    let idleTimer;
    let hiddenTimer;
    let sessionTimer;
    const channel = typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel("timber-lock");

    const lock = (announce) => {
      clearTimeout(idleTimer);
      clearTimeout(hiddenTimer);
      clearTimeout(sessionTimer);
      if (announce) channel?.postMessage({ type: "lock" });
      lockRef.current();
    };

    channel?.addEventListener("message", (event) => {
      if (event.data?.type === "lock") lock(false);
    });

    // "Never" disables only automatic locking. An explicit Lock Timber action
    // and a lock from another open tab still wipe this session immediately.
    if (selected === LOCK_POLICIES.never) {
      return () => channel?.close();
    }

    // The two-hour choice is a session lease, rather than an idle timer: using
    // Timber during the window does not silently extend the promise made by
    // the setting. A hidden tab receives the same two-hour treatment.
    if (selected === LOCK_POLICIES.twoHours) {
      sessionTimer = setTimeout(() => lock(true), SESSION_LOCK_MS);
      return () => {
        clearTimeout(sessionTimer);
        channel?.close();
      };
    }

    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => lock(true), IDLE_LOCK_MS);
    };
    const visibility = () => {
      clearTimeout(hiddenTimer);
      if (document.visibilityState === "hidden") {
        hiddenTimer = setTimeout(() => lock(true), HIDDEN_LOCK_MS);
      } else {
        resetIdle();
      }
    };
    const activity = () => resetIdle();
    const events = ["pointerdown", "keydown", "touchstart"];
    for (const event of events) window.addEventListener(event, activity, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    resetIdle();

    return () => {
      clearTimeout(idleTimer);
      clearTimeout(hiddenTimer);
      clearTimeout(sessionTimer);
      for (const event of events) window.removeEventListener(event, activity);
      document.removeEventListener("visibilitychange", visibility);
      channel?.close();
    };
  }, [enabled, policy]);
}
