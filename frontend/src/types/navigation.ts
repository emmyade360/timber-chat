// Where a tapped notification should land, and the routes it can land on.

/**
 * Latched at page load from the URL, or delivered by the service worker to a
 * tab that is already open. Consumed once the vault is unlocked.
 */
export type NotificationTarget =
  | { kind: "chat"; conversationId: string }
  | { kind: "call"; conversationId: string }
  | { kind: "people" };

/** Narrows an untrusted `postMessage` or URL read. Never trust the shape. */
export function isNotificationTarget(value: unknown): value is NotificationTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as { kind?: unknown; conversationId?: unknown };
  if (target.kind === "people") return true;
  if (target.kind !== "chat" && target.kind !== "call") return false;
  return typeof target.conversationId === "string" && target.conversationId.length > 0;
}

/** Every addressable destination. Overlays are deliberately absent: recovery
 *  phrase, PIN change, device wipe and call controls are not history entries. */
export const ROUTES = {
  root: "/",
  chats: "/chats",
  conversation: "/chats/:conversationId",
  vault: "/vault",
  vaultPeople: "/vault/people",
  vaultExplore: "/vault/explore",
  profile: "/profile",
  profileEdit: "/profile/edit",
  settings: "/profile/settings",
  settingsGrowth: "/profile/settings/growth",
  settingsInvite: "/profile/settings/invite",
  settingsNotifications: "/profile/settings/notifications",
  settingsTransfer: "/profile/settings/transfer",
} as const;

export type RoutePattern = (typeof ROUTES)[keyof typeof ROUTES];

export const conversationPath = (conversationId: string): string =>
  `/chats/${encodeURIComponent(conversationId)}`;
