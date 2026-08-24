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
  getReceipts,
  postReadReceipts,
} from "./api.js";
import { currentIdentity } from "../crypto/session.js";
import { payloads } from "../crypto/envelope.js";
import {
  composeMessage,
  confirmMessage,
  deleteConversation,
  deletePeer,
  getConversation,
  getMeta,
  listConversations,
  markDeliveredAck,
  markReadAck,
  markReceipt,
  markSeen,
  messagesFor,
  pendingMessages,
  presentMessages,
  putMessage,
  putPeer,
  PeerKeyVerificationError,
  setMeta,
  unacknowledgedMessageIds,
  unreadAckedMessageIds,
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
      // Carried so the chat list and header can show the peer's stone without
      // a second lookup; it is public profile data, not conversation content.
      peerLevel: conversation.peer.level,
      peerLevelName: conversation.peer.level_name,
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
        seen: false,
        deliveredAt: message.delivered_at ? toMillis(message.delivered_at) : null,
        readAt: message.read_at ? toMillis(message.read_at) : null,
      });
      stored += 1;
    }
    if (reachedLocalHistory || data.length < PAGE_SIZE) break;
    before = data[0].created_at;
  }
  return stored;
}

/** True when the app is actually on screen, not merely mounted. */
export const documentVisible = () =>
  typeof document === "undefined" || document.visibilityState === "visible";

/**
 * The live socket sender, registered by useWebSocket.
 *
 * A registry rather than a parameter because `reconcileRealtime` coalesces
 * concurrent calls into one shared promise: threading `send` through the
 * argument list meant whichever caller happened to win the race decided whether
 * receipts were sent at all, and the sendless bootstrap normally won.
 */
let realtimeSend = null;

export function setRealtimeSend(next) {
  realtimeSend = next;
}

const emit = (type, payload) => (realtimeSend ? realtimeSend(type, payload) : false);

/**
 * Tell a sender which of their messages this device now holds, or has opened.
 *
 * Both receipts work the same way and both are swept rather than fired per
 * arrival, because the case that matters is a device that was offline: the
 * messages were stored by a backfill, so there was never a moment to
 * acknowledge them one at a time. Nothing is marked sent until the wire has
 * taken it, so a failure simply waits for the next sweep.
 */
async function sweepReceipts(conversationId, { ids, event, mark, fallback }) {
  if (!ids.length) return 0;
  if (emit(event, { conversation_id: conversationId, message_ids: ids })) {
    await mark(ids);
    return ids.length;
  }
  if (fallback) {
    try {
      await fallback(conversationId, ids);
      await mark(ids);
      return ids.length;
    } catch {
      // Neither transport was available; the next sweep tries again.
    }
  }
  return 0;
}

export async function acknowledgeDelivery(conversationId) {
  const selfId = currentIdentity().userId;
  return sweepReceipts(conversationId, {
    ids: await unacknowledgedMessageIds(conversationId, selfId),
    event: "receipt.delivered",
    mark: markDeliveredAck,
  });
}

/**
 * Tell the sender their messages were opened.
 *
 * Falls back to HTTP when the socket is down: the read flag is already
 * committed locally, and before this existed a receipt attempted while
 * disconnected was simply lost forever.
 */
export async function acknowledgeRead(conversationId) {
  const selfId = currentIdentity().userId;
  return sweepReceipts(conversationId, {
    ids: await unreadAckedMessageIds(conversationId, selfId),
    event: "receipt.read",
    mark: markReadAck,
    fallback: (id, ids) => postReadReceipts(id, ids),
  });
}

/**
 * Pull the receipt state of our own recent messages back down.
 *
 * Receipts are broadcast-only, so one that fires while this device is offline
 * is gone; and `backfill` deliberately skips messages it already holds, so it
 * can never repair them. This is the only path by which a sender catches up.
 */
export async function syncReceipts(conversationId) {
  const cursorKey = `receipts:${conversationId}`;
  const since = (await getMeta(cursorKey))?.since ?? null;
  const { data } = await getReceipts(conversationId, since);
  const delivered = data.filter((entry) => entry.delivered_at).map((entry) => entry.id);
  const read = data.filter((entry) => entry.read_at).map((entry) => entry.id);
  if (delivered.length) {
    await markReceipt(delivered, "deliveredAt");
    useChatStore.getState().markReceipt(delivered, "deliveredAt");
  }
  if (read.length) {
    await markReceipt(read, "readAt");
    useChatStore.getState().markReceipt(read, "readAt");
  }
  await setMeta(cursorKey, { since: new Date().toISOString() });
  return delivered.length + read.length;
}

let reconciliation = null;
let reconcileQueued = false;

/**
 * Reconcile after every socket connection and as a small self-healing fallback.
 * It is coalesced so reconnect, an incoming event, and app bootstrap never race
 * through competing history downloads; a request that arrives mid-flight sets a
 * latch so it is not simply swallowed.
 */
export function reconcileRealtime() {
  if (reconciliation) {
    reconcileQueued = true;
    return reconciliation;
  }
  reconciliation = (async () => {
    let conversations = [];
    do {
      reconcileQueued = false;
      conversations = await syncConversations({ reconcile: true });
      await Promise.all(conversations.map((conversation) => backfill(conversation.id)));
      await refreshConversationList();
      await flushOutbox();
      // Once the backlog has landed: tell the senders it arrived, tell them
      // about anything already opened, and collect what they told us.
      await Promise.all(conversations.flatMap((conversation) => [
        acknowledgeDelivery(conversation.id),
        acknowledgeRead(conversation.id),
        syncReceipts(conversation.id).catch(() => 0),
      ]));
    } while (reconcileQueued);
    return conversations;
  })().finally(() => { reconciliation = null; });
  return reconciliation;
}

/**
 * Resend anything that was composed while offline.
 *
 * These rows were written optimistically and stay `pending` forever otherwise,
 * showing an unsent marker and skewing the backfill high-water mark.
 */
export async function flushOutbox() {
  const stuck = await pendingMessages();
  let sent = 0;
  for (const message of stuck) {
    const delivered = emit("message.send", {
      conversation_id: message.conversationId,
      client_id: message.id,
      ...message.envelope,
    });
    if (!delivered) break;
    sent += 1;
  }
  return sent;
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
    seen: true,
    scheduledAt,
    payload: outgoingPayload,
  });

  return { clientId, envelope };
}

/** Send an ordinary sealed envelope from code that is not the chat composer.
 * Call history uses this so its status is encrypted just like any other message.
 */
export async function sendEncryptedPayload(send, conversationId, payload) {
  const { clientId, envelope } = await prepareOutgoingPayload(conversationId, payload);
  const delivered = send("message.send", {
    conversation_id: conversationId,
    client_id: clientId,
    ...envelope,
  });
  if (!delivered) throw new Error("Realtime connection is unavailable.");
  return clientId;
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
      seen: true,
    });
  } else {
    await putMessage({
      id: payload.id,
      conversationId,
      senderId: payload.sender_id,
      createdAt: toMillis(payload.created_at),
      envelope: payload,
      // A phone that locks with the chat mounted still has activeConversationId
      // set. Without the visibility check those arrivals would be marked seen
      // and dropped from the badge while nobody was looking at them.
      seen: mine || (isActive && documentVisible()),
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

/**
 * Mark a conversation seen locally, then tell the sender.
 *
 * The two steps are separate on purpose: clearing the badge must always work,
 * while the receipt can fail and be retried by the next sweep.
 */
export async function markConversationRead(conversationId) {
  const selfId = currentIdentity().userId;
  await markSeen(conversationId, selfId);
  useChatStore.getState().clearUnread(conversationId);
  return acknowledgeRead(conversationId);
}
