// HTTP client.
//
// The session token lives in memory only, never in localStorage. It does not need
// to be persisted: after a PIN unlock the app holds the recovery phrase, so it can
// silently re-authenticate by signing a fresh challenge. Nothing an attacker could
// scrape from disk grants access.

import axios from "axios";

const configuredApiUrl = import.meta.env.VITE_API_URL?.trim();
const configuredWsUrl = import.meta.env.VITE_WS_URL?.trim();
const baseURL = configuredApiUrl || "http://localhost:8080";

function localPage() {
  return typeof window !== "undefined"
    && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

function validPublicUrl(value, protocols) {
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** A non-sensitive explanation for a deployment that was built with bad public URLs. */
export function runtimeConfigurationError() {
  if (typeof window === "undefined" || localPage()) return null;
  if (!configuredApiUrl || !configuredWsUrl) {
    return "Timber is not configured for this site yet. Please contact the site operator.";
  }
  if (!validPublicUrl(configuredApiUrl, ["https:"]) || !validPublicUrl(configuredWsUrl, ["wss:"])) {
    return "Timber requires secure service connections. Please contact the site operator.";
  }
  return null;
}

const api = axios.create({
  baseURL,
  timeout: 15_000,
  headers: { Accept: "application/json" },
});

/**
 * The relay is hosted on a free tier that suspends after inactivity, and a cold
 * start there routinely runs past thirty seconds. The default 15s budget cannot
 * outlast that, so the first request after a sleep was not merely slow -- it
 * could never succeed. Waking calls get their own, longer budget: 45s covers
 * the great majority of cold starts while still failing a genuinely dead relay
 * in bounded time rather than hanging on it.
 *
 * This is only for requests that may legitimately be waiting on a cold start:
 * the liveness probe and the unauthenticated auth handshake. Everything else
 * keeps the short timeout, because by then the relay is demonstrably awake and
 * a long hang is a fault rather than a wake-up.
 */
export const WAKE_TIMEOUT_MS = 45_000;

let token = null;
const listeners = new Set();
let sessionRefresher = null;
let refreshInFlight = null;

export function setToken(next) {
  token = next;
  for (const listener of listeners) listener(token);
}

export function getToken() {
  return token;
}

export function clearToken() {
  setToken(null);
}

export function onTokenChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Register the in-memory identity-backed refresh used after a 15-minute expiry. */
export function setSessionRefresher(refresher) {
  sessionRefresher = refresher;
}

api.interceptors.request.use((config) => {
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error?.config;
    const isAuthRequest = config?.url?.startsWith("/auth/");
    if (
      error?.response?.status !== 401
      || !token
      || !sessionRefresher
      || isAuthRequest
      || config?._timberRetried
    ) {
      return Promise.reject(error);
    }
    config._timberRetried = true;
    try {
      refreshInFlight ??= Promise.resolve(sessionRefresher()).finally(() => {
        refreshInFlight = null;
      });
      await refreshInFlight;
      return api.request(config);
    } catch {
      clearToken();
      return Promise.reject(error);
    }
  },
);

const SENSITIVE_ERROR_TEXT = /\b(stack(?:\s+trace)?|exception|postgres|sql(?:state)?|supabase|password|secret|bearer|token|authorization|at\s+\S+\s*\()/i;

/**
 * What to say while the relay is coming back.
 *
 * The instance suspends when nobody is talking and takes tens of seconds to
 * wake, so "cannot connect" would be wrong as often as it is right -- the usual
 * cause is a server on its way up, not a broken one. The wording sets the
 * expectation (it takes a moment), says it is being handled, and asks for a
 * retry rather than leaving the person guessing.
 *
 * It names no host, tier, provider, or status code, so it stays inside the same
 * rule as everything else here: useful to the person, useless to an attacker
 * mapping the backend.
 */
export const WAKING_MESSAGE =
  "Timber is waking up — this can take up to a minute. We're on it; please try again shortly.";

export const OFFLINE_MESSAGE =
  "You're offline. Timber will reconnect on its own once you're back.";

/** True when the browser is certain there is no connection. */
function browserIsOffline() {
  // `onLine === true` is only a hint that a network exists, so it is never used
  // as proof of reachability -- but `false` is reliable, and worth saying plainly.
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Convert failures into messages that are useful but cannot reveal transport,
 * backend, or credential details. Server messages are shown only for expected
 * client errors and only after a conservative content check.
 */
export function userMessage(error, fallback = "Something went wrong. Please try again.") {
  const response = error?.response;

  if (!response) {
    if (browserIsOffline()) return OFFLINE_MESSAGE;
    // A timeout and a refused connection look the same from here, and both are
    // what a suspended instance produces while it starts.
    return WAKING_MESSAGE;
  }

  if (response.status === 401) return "Your session expired. Unlock Timber to reconnect.";
  if (response.status === 429) return "Too many attempts. Please wait a moment and try again.";

  // A gateway that cannot reach the app is the other face of a cold start: the
  // edge answers, the instance behind it is not listening yet. Worth overriding
  // the caller's fallback for, because "Could not sign in" is actively
  // misleading when the only problem is a server still starting.
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return WAKING_MESSAGE;
  }
  // Any other 5xx keeps the caller's fallback, which names what was being
  // attempted and is more use than a generic apology.

  const message = response.data?.error;
  const expectedClientError = response.status >= 400 && response.status < 500;
  if (
    expectedClientError
    && typeof message === "string"
    && message.length > 0
    && message.length <= 240
    && !SENSITIVE_ERROR_TEXT.test(message)
  ) {
    return message;
  }
  return fallback;
}

/** Convert an Axios failure into the safe application error used by auth flows. */
export function apiError(error, fallback = "Something went wrong. Please try again.") {
  return new Error(userMessage(error, fallback));
}

// --- endpoints -------------------------------------------------------------

/** Unauthenticated liveness probe; also reports the relay's running version. */
export const getHealth = () => api.get("/health", { timeout: WAKE_TIMEOUT_MS });

let warming = null;

/**
 * Start waking the relay, without waiting for it.
 *
 * Called as early as the app can manage, because the wake-up runs in parallel
 * with everything the user does next -- reading the lock screen, typing a PIN,
 * deriving a key. By the time a session is actually needed the instance has
 * often been up for some seconds already.
 *
 * Deduplicated: several callers share one probe, and the result is cached so a
 * later caller learns the outcome without issuing a second request.
 */
export function warmRelay() {
  warming ??= getHealth().then(() => true, () => false);
  return warming;
}

/** Testing seam: forget the cached probe. */
export function resetRelayWarmup() {
  warming = null;
}
export const getCurrentUser = () => api.get("/api/users/me");
export const updateCurrentUser = (profile) => api.patch("/api/users/me", profile);
export const getConversations = () => api.get("/api/conversations");
export const getHistory = (conversationId, params) =>
  api.get(`/api/conversations/${conversationId}/messages`, { params });
/**
 * Receipt state for our own recent messages in a conversation.
 *
 * Separate from history because history skips messages the device already
 * holds -- which is exactly the set whose receipts need repairing. This returns
 * ids and two timestamps, no ciphertext.
 */
export const getReceipts = (conversationId, since) =>
  api.get(`/api/conversations/${conversationId}/receipts`, { params: since ? { since } : {} });
/** Durable read receipts for when the socket is down. */
export const postReadReceipts = (conversationId, messageIds) =>
  api.post(`/api/conversations/${conversationId}/read`, { message_ids: messageIds });
export const getFriends = () => api.get("/api/friends");
export const getPendingRequestsCount = () => api.get("/api/friends/requests/count");
export const searchUsers = (q) => api.get("/api/users/search", { params: { q } });
export const sendFriendRequest = (receiverId) =>
  api.post("/api/friends/request", { receiver_id: receiverId });
export const respondToFriendRequest = (requestId, approve) =>
  api.post(`/api/friends/requests/${requestId}/respond`, { approve });
export const removeFriend = (friendId) => api.delete(`/api/friends/${friendId}`);
export const getGrowth = () => api.get("/api/growth");
export const getStreaks = () => api.get("/api/streaks");
export const getLeaderboard = () => api.get("/api/leaderboard");
export const setLeaderboardOptIn = (optedIn) =>
  api.post("/api/leaderboard/opt-in", { opted_in: optedIn });
export const getInvite = () => api.get("/api/invite");
export const lookupInvite = (code) => api.get(`/invites/${encodeURIComponent(code)}`);

/**
 * The shareable form of an invite code.
 *
 * Built from the page's own origin so a self-hosted deployment produces links that
 * point at itself rather than at a hard-coded domain.
 */
export const inviteUrl = (code) => `${window.location.origin}/?invite=${code}`;

/** Read an invite code out of the landing URL, if the visitor arrived by one. */
/**
 * An invite code is a capability: it auto-friends the bearer with the inviter.
 * So it is read once and scrubbed out of the address bar, which stops it being
 * carried in browser history, in a link the visitor shares or bookmarks, or in
 * any page-level analytics that records the current URL.
 *
 * The scrub happens exactly once and the result is memoised, so repeat calls --
 * including StrictMode's deliberate double-invocation of state initialisers --
 * return the same code rather than losing it on the second read.
 */
let landingInviteCode;

export function inviteCodeFromUrl() {
  if (landingInviteCode !== undefined) return landingInviteCode;
  if (typeof window === "undefined") return null;

  const search = new URLSearchParams(window.location.search);
  const fromQuery = search.get("invite");
  if (fromQuery !== null) {
    search.delete("invite");
    const query = search.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
  }
  landingInviteCode = (fromQuery ?? "").trim().toUpperCase() || null;
  return landingInviteCode;
}
export const createWebSocketTicket = () => api.post("/api/ws-ticket");
export const getWebRtcIceServers = () => api.get("/api/webrtc/ice-servers");
export const getPendingCalls = () => api.get("/api/calls/pending");
export const savePushSubscription = (subscription) => api.post("/api/push-subscriptions", subscription);
export const removePushSubscription = (endpoint) => api.delete("/api/push-subscriptions", { data: { endpoint } });
export const logout = () => api.post("/api/auth/logout");
export const uploadEncrypted = (blob) => {
  const form = new FormData();
  form.append("file", new Blob([blob], { type: "application/octet-stream" }), "sealed");
  return api.post("/api/upload", form);
};
export const downloadEncrypted = (attachmentId) =>
  api.get(`/api/attachments/${encodeURIComponent(attachmentId)}`, { responseType: "arraybuffer" });
export const getExploreProfile = () => api.get("/api/explore/profile");
export const updateExploreProfile = (profile) => api.put("/api/explore/profile", profile);
export const getExploreCards = () => api.get("/api/explore/cards");
export const likeExploreCard = (id) => api.post(`/api/explore/cards/${encodeURIComponent(id)}/like`);
export const passExploreCard = (id) => api.post(`/api/explore/cards/${encodeURIComponent(id)}/pass`);
export const blockExploreCard = (id) => api.post(`/api/explore/cards/${encodeURIComponent(id)}/block`);
export const reportExploreCard = (id, report) =>
  api.post(`/api/explore/cards/${encodeURIComponent(id)}/report`, report);
export const getExploreMatches = () => api.get("/api/explore/matches");

export default api;
