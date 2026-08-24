// Whether there is room for the three-pane layout.
//
// This is a JS breakpoint rather than a CSS one because the two layouts are
// different component trees, not the same tree restyled: on desktop the chat
// list stays mounted beside the conversation, which is what preserves its
// scroll position and stops navigation disappearing the moment you open a
// message. CSS alone cannot express "keep this mounted".

import { useSyncExternalStore } from "react";

export const DESKTOP_QUERY = "(min-width: 900px)";

const supported = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function";

function subscribe(onChange) {
  if (!supported()) return () => {};
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const getSnapshot = () => (supported() ? window.matchMedia(DESKTOP_QUERY).matches : false);

/**
 * `useSyncExternalStore` rather than state plus an effect: the viewport is
 * external state that can change between render and commit, and this reads it
 * at the right moment without a cascading re-render on mount.
 */
export function useIsDesktop() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
