// Locks decrypted material after a short idle period and coordinates every open
// Timber tab. Browser tabs do not share JavaScript memory, so each must wipe its
// own derived keys when one of them is explicitly locked.

import { useEffect, useRef } from "react";

export const IDLE_LOCK_MS = 5 * 60 * 1000;
export const HIDDEN_LOCK_MS = 30 * 1000;

export function useAutoLock(enabled, onLock) {
  const lockRef = useRef(onLock);

  useEffect(() => {
    lockRef.current = onLock;
  }, [onLock]);

  useEffect(() => {
    if (!enabled) return undefined;
    let idleTimer;
    let hiddenTimer;
    const channel = typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel("timber-lock");

    const lock = (announce) => {
      clearTimeout(idleTimer);
      clearTimeout(hiddenTimer);
      if (announce) channel?.postMessage({ type: "lock" });
      lockRef.current();
    };
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
    channel?.addEventListener("message", (event) => {
      if (event.data?.type === "lock") lock(false);
    });
    resetIdle();

    return () => {
      clearTimeout(idleTimer);
      clearTimeout(hiddenTimer);
      for (const event of events) window.removeEventListener(event, activity);
      document.removeEventListener("visibilitychange", visibility);
      channel?.close();
    };
  }, [enabled]);
}
