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
 * Convert failures into messages that are useful but cannot reveal transport,
 * backend, or credential details. Server messages are shown only for expected
 * client errors and only after a conservative content check.
 */
export function userMessage(error, fallback = "Something went wrong. Please try again.") {
  const response = error?.response;
  if (!response) {
    if (error?.code === "ECONNABORTED") return "Timber is taking too long to respond. Please try again.";
    return "Timber can’t reach the service right now. Check your connection and try again.";
  }
  if (response.status === 401) return "Your session expired. Unlock Timber to reconnect.";
  if (response.status === 429) return "Too many attempts. Please wait a moment and try again.";
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

export const getCurrentUser = () => api.get("/api/users/me");
export const updateCurrentUser = (profile) => api.patch("/api/users/me", profile);
export const getConversations = () => api.get("/api/conversations");
export const getHistory = (conversationId, params) =>
  api.get(`/api/conversations/${conversationId}/messages`, { params });
export const getFriends = () => api.get("/api/friends");
export const getPendingRequestsCount = () => api.get("/api/friends/requests/count");
export const searchUsers = (q) => api.get("/api/users/search", { params: { q } });
export const sendFriendRequest = (receiverId) =>
  api.post("/api/friends/request", { receiver_id: receiverId });
export const respondToFriendRequest = (requestId, approve) =>
  api.post(`/api/friends/requests/${requestId}/respond`, { approve });
export const removeFriend = (friendId) => api.delete(`/api/friends/${friendId}`);
export const getGrowth = () => api.get("/api/growth");
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
