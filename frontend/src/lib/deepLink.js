// Where a tapped notification should land.
//
// The app has no router and no persistent session: `Shell` only mounts once the
// vault is unlocked, and a cold start from a notification goes through the PIN
// screen first. So the target cannot be handled where it arrives — it is
// latched here and consumed once the app is actually ready.
//
// Two ways in. A cold start carries it in the URL, which is read and scrubbed
// on module load for the same reason the invite code is: it should not sit in
// history or reach an analytics pageview. A running tab gets it by postMessage
// from the service worker, because navigating that tab would throw away its
// unlocked session.

let pendingTarget = null;
const listeners = new Set();

function announce(target) {
  pendingTarget = target;
  for (const listener of listeners) {
    try { listener(target); } catch { /* a bad listener must not block the rest */ }
  }
}

/** Read a target out of the landing URL and scrub the parameters away. */
function readFromUrl() {
  if (typeof window === "undefined") return null;
  const search = new URLSearchParams(window.location.search);
  const conversationId = search.get("c");
  const isCall = search.get("call") === "1";
  const isPeople = search.get("people") === "1";
  if (!conversationId && !isCall && !isPeople) return null;

  search.delete("c");
  search.delete("call");
  search.delete("people");
  const query = search.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
  );

  if (isCall) return { kind: "call", conversationId };
  if (conversationId) return { kind: "chat", conversationId };
  return { kind: "people" };
}

/**
 * Start listening. Safe to call more than once; only the first call binds.
 * Runs before render so the URL is clean before anything else reads it.
 */
let started = false;

export function startDeepLinks() {
  if (started || typeof window === "undefined") return;
  started = true;

  const fromUrl = readFromUrl();
  if (fromUrl) pendingTarget = fromUrl;

  navigator.serviceWorker?.addEventListener("message", (event) => {
    if (event.data?.type === "timber-open" && event.data.target) {
      announce(event.data.target);
    }
  });
}

/** Take the pending target, if any. Returns null once consumed. */
export function consumePendingTarget() {
  const target = pendingTarget;
  pendingTarget = null;
  return target;
}

/** Be told about targets that arrive while the app is already running. */
export function subscribePendingTarget(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
