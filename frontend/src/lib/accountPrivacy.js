// Account state starts unknown. Optional analytics may only run in a known
// standard session, including when a script from a previous session is present.
let anonymous = null;
let active = false;
let accountId = null;
let activeId = null;
const listeners = new Set();

export function analyticsAllowed() {
  return active && activeId !== null && accountId === activeId && anonymous === false;
}

function notify() {
  for (const listener of listeners) listener();
}

export function setAccountPrivacy(value, userId = null) {
  anonymous = typeof value === "boolean" ? value : null;
  accountId = userId;
  notify();
}

export function setPrivacyIdentity(userId) {
  activeId = userId;
  if (userId === null) active = false;
  notify();
}

export function setAnalyticsSessionActive(value) {
  active = value === true;
  notify();
}

export function subscribeAccountPrivacy(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function filterAnalyticsEvent(event) {
  return analyticsAllowed() ? event : null;
}
