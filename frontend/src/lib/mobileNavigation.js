// Centralises the small amount of state the three-tab mobile shell owns. This
// keeps notification targets and bottom-tab taps from drifting into different
// destinations as the discovery area grows.

export function mobileTabSelection(tab) {
  if (tab === "vault") return { tab: "vault", vaultPage: "root", closeConversation: true };
  if (tab === "profile") return { tab: "profile", vaultPage: null, closeConversation: true };
  return { tab: "chats", vaultPage: null, closeConversation: true };
}

export function notificationMobileDestination(kind) {
  return kind === "people" ? { tab: "vault", vaultPage: "people" } : { tab: "chats", vaultPage: null };
}
