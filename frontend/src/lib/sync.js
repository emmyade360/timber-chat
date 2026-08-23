// Keeps the encrypted local database and the server in step.
//
// The local database is the source of truth for what the user sees; the server is
// a transport that holds ciphertext so messages survive being offline and can reach
// a freshly restored device. Reads come from local storage first so the UI paints
// instantly and works with no connection at all.

import {
  getConversations,
  getCurrentUser,
  getFriends,
  getHistory,
  getGrowth,
} from "./api.js";
import { currentIdentity } from "../crypto/session.js";
import { payloads } from "../crypto/envelope.js";
import {
  composeMessage,
  confirmMessage,
  deleteConversation,
  deletePeer,
  getConversation,
  listConversations,
  markRead as markReadLocally,
  messagesFor,
  presentMessages,
  putMessage,
  putPeer,
  PeerKeyVerificationError,
  unreadCount,
  upsertConversation,
} from "../db/localStore.js";
import { useChatStore } from "../store/chatStore.js";

const PAGE_SIZE = 50;

const toMillis = (value) => new Date(value).getTime();

/** Mirror the server's conversation list into local storage. */
export async function syncConversations({ reconcile = false } = {}) {
  const { data } = await getConversations();
  for (const conversation of data) {
    let securityError = null;
    try {
      await putPeer(conversation.peer);
    } catch (error) {
      if (!(error instanceof PeerKeyVerificationError)) throw error;
      if (!error.retainExisting) await deletePeer(conversation.peer.id);
      securityError = error.message;
    }
    await upsertConversation({
      id: conversation.id,
      peerId: conversation.peer.id,
      peerUsername: conversation.peer.username,
      createdAt: toMillis(conversation.created_at),
      updatedAt: conversation.last_message_at ? toMillis(conversation.last_message_at) : 0,
      securityError,
    });
  }
  if (reconcile) {
    const currentIds = new Set(data.map((conversation) => conversation.id));
    const stale = (await listConversations()).filter((conversation) => !currentIds.has(conversation.id));
    for (const conversation of stale) {
      await deleteConversation(conversation.id, conversation.peerId);
      useChatStore.getState().removeConversation(conversation.id);
    }
  }
  return data;
}

/**
 * Pull anything that arrived while this device was away.
 *
 * Only messages newer than the local high-water mark are requested, so a normal
 * launch is one small call rather than a full re-download.
 */
export async function backfill(conversationId) {
  const local = await messagesFor(conversationId, { limit: 1 });
  const since = local.at(-1)?.createdAt ?? null;
  let stored = 0;
  let before = null;
  // Work backwards until we reach the local high-water mark. This avoids a
  // subtle gap where more than one server page arrives while the device is
  // offline: the old one-page fetch silently skipped older missed messages.
  while (true) {
    const { data } = await getHistory(conversationId, { limit: PAGE_SIZE, before });
    if (!data.length) break;
    let reachedLocalHistory = false;
    for (const message of data) {
      const createdAt = toMillis(message.created_at);
      if (since && createdAt <= since) {
        reachedLocalHistory = true;
        continue;
      }
      await putMessage({
        id: message.id,
        conversationId: message.conversation_id,
        senderId: message.sender_id,
        createdAt,
        envelope: message,
        read: false,
      });
      stored += 1;
    }
    if (reachedLocalHistory || data.length < PAGE_SIZE) break;
    before = data[0].created_at;
  }
  return stored;
}

let reconciliation = null;

/**
 * Reconcile after every socket connection and as a small self-healing fallback.
 * It is coalesced so reconnect, an incoming event, and app bootstrap never race
 * through competing history downloads.
 */
export function reconcileRealtime() {
  reconciliation ??= (async () => {
    const conversations = await syncConversations({ reconcile: true });
    await Promise.all(conversations.map((conversation) => backfill(conversation.id)));
    await refreshConversationList();
    return conversations;
  })().finally(() => { reconciliation = null; });
  return reconciliation;
}

/** Load a conversation into the store, local-first. */
export async function loadConversation(conversationId) {
  const store = useChatStore.getState();
  store.setMessages(conversationId, presentMessages(await messagesFor(conversationId, { limit: PAGE_SIZE })));

  try {
    if (await backfill(conversationId)) {
      store.setMessages(conversationId, presentMessages(await messagesFor(conversationId, { limit: PAGE_SIZE })));
    }
  } catch {
    // Offline: the locally stored history above is still correct and complete
    // up to the last time this device was connected.
  }
  store.setUnread(conversationId, await unreadCount(conversationId));
}

/** Page further back through history for infinite scroll. */
export async function loadOlder(conversationId) {
  const store = useChatStore.getState();
  const current = store.messages[conversationId] ?? [];
  if (current.length === 0) return 0;

  const older = await messagesFor(conversationId, {
    before: current[0].createdAt,
    limit: PAGE_SIZE,
  });
  if (older.length) store.prependMessages(conversationId, presentMessages(older));
  return older.length;
}

/** Refresh the conversation list in the store from local storage. */
export async function refreshConversationList() {
  const store = useChatStore.getState();
  const local = await listConversations();
  const withPreview = await Promise.all(
    local.map(async (conversation) => ({
      ...conversation,
      preview: presentMessages(await messagesFor(conversation.id, { limit: PAGE_SIZE })).at(-1) ?? null,
      unread: await unreadCount(conversation.id),
    })),
  );
  store.setConversations(withPreview);
  for (const conversation of withPreview) {
    store.setUnread(conversation.id, conversation.unread);
  }
}

/** Everything needed to paint the app after unlock. */
export async function bootstrap() {
  const store = useChatStore.getState();
  store.setSyncing(true);
  try {
    await refreshConversationList(); // local first: paints immediately, works offline

    const [me, growthPath, friends] = await Promise.all([
      getCurrentUser(),
      getGrowth(),
      getFriends(),
    ]);
    store.setMe(me.data);
    store.setLadder(growthPath.data);
    store.setFriends(friends.data);

    await reconcileRealtime();
  } finally {
    store.setSyncing(false);
  }
}

/**
 * Seal a message, store it optimistically, and hand the envelope to the caller
 * to put on the wire. It is stored before it is sent so a dropped connection
 * cannot lose what the user typed.
 */
export async function prepareOutgoingPayload(conversationId, payload, { createdAt = Date.now(), scheduledAt = null } = {}) {
  const clientId = `pending-${crypto.randomUUID()}`;
  // This copy is sealed into the envelope so the local database never gains a
  // clear-text scheduling field. The server separately sees only deliver_after.
  const outgoingPayload = scheduledAt
    ? { ...payload, scheduled_at: new Date(scheduledAt).toISOString() }
    : payload;
  const envelope = await composeMessage({
    conversationId,
    payload: outgoingPayload,
    id: clientId,
    createdAt,
  });

  const store = useChatStore.getState();
  store.appendMessage(conversationId, {
    id: clientId,
    conversationId,
    senderId: currentIdentity().userId,
    createdAt,
    pending: true,
    read: true,
    scheduledAt,
    payload: outgoingPayload,
  });

  return { clientId, envelope };
}

export async function prepareOutgoing(conversationId, text, options = {}) {
  return prepareOutgoingPayload(conversationId, payloads.text(text, options));
}

/** Fold an inbound `message.new` event into local storage and the UI. */
export async function receiveMessage(payload) {
  const store = useChatStore.getState();
  const conversationId = payload.conversation_id;
  const identity = currentIdentity();
  const mine = payload.sender_id === identity.userId;
  const isActive = store.activeConversationId === conversationId;

  if (!(await getConversation(conversationId))) {
    // A message for a conversation this device has not seen yet -- a friend
    // accepted while we were away.
    try {
      await syncConversations();
    } catch {
      return;
    }
  }

  if (mine && payload.client_id) {
    await confirmMessage(payload.client_id, {
      id: payload.id,
      conversationId,
      senderId: payload.sender_id,
      createdAt: toMillis(payload.created_at),
      envelope: payload,
      read: true,
    });
  } else {
    await putMessage({
      id: payload.id,
      conversationId,
      senderId: payload.sender_id,
      createdAt: toMillis(payload.created_at),
      envelope: payload,
      read: mine || isActive,
    });
  }

  // A control envelope can alter an older message, so always fold the complete
  // local page rather than appending opaque controls as visible chat bubbles.
  const projected = presentMessages(await messagesFor(conversationId, { limit: PAGE_SIZE }));
  store.setMessages(conversationId, projected);
  store.setUnread(conversationId, await unreadCount(conversationId));
  await refreshConversationList();
  return {
    isActive,
    mine,
    message: projected.find((message) => message.id === payload.id) ?? null,
  };
}

/** Mark a conversation read locally and report which messages changed. */
export async function markConversationRead(conversationId) {
  const changed = await markReadLocally(conversationId);
  useChatStore.getState().clearUnread(conversationId);
  return changed;
}
