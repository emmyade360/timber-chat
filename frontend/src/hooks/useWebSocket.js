// One socket for the whole session, not one per conversation.
//
// The local database must stay current for every chat, not only the one on screen,
// so the socket is opened once on unlock and lives for the whole session. It also
// reconnects with backoff, because a chat app that silently stops receiving is
// worse than one that visibly disconnects.

import { useCallback, useEffect, useRef, useState } from "react";
import { createWebSocketTicket, getToken } from "../lib/api.js";
import { signIn } from "../lib/auth.js";
import { currentIdentity, isUnlocked } from "../crypto/session.js";
import { useChatStore } from "../store/chatStore.js";
import {
  acknowledgeDelivery,
  acknowledgeRead,
  documentVisible,
  markConversationRead,
  receiveMessage,
  reconcileRealtime,
  setRealtimeSend,
} from "../lib/sync.js";
import { markReceipt } from "../db/localStore.js";
import { getCurrentUser, getFriends } from "../lib/api.js";
import { notifyFriendAccepted, notifyFriendRequest, notifyIncoming } from "../lib/notifications.js";

const MAX_BACKOFF_MS = 15_000;
const MAX_REALTIME_EVENT_BYTES = 96 * 1024;

export function useWebSocket(enabled) {
  const socketRef = useRef(null);
  const attemptRef = useRef(0);
  const closedByUs = useRef(false);
  const subscribersRef = useRef(new Set());
  const [connected, setConnected] = useState(false);

  const send = useCallback((type, payload) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      const event = JSON.stringify({ type, payload });
      if (event.length > MAX_REALTIME_EVENT_BYTES) return false;
      socketRef.current.send(event);
      return true;
    }
    return false;
  }, []);

  /** Subscribe to authenticated ephemeral events such as WebRTC signalling. */
  const subscribe = useCallback((listener) => {
    subscribersRef.current.add(listener);
    return () => subscribersRef.current.delete(listener);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    closedByUs.current = false;
    let reconnectTimer;
    let reconcileTimer;
    const typingTimers = new Map();

    const scheduleReconnect = () => {
      if (closedByUs.current) return;
      attemptRef.current += 1;
      const delay = Math.min(500 * 2 ** attemptRef.current, MAX_BACKOFF_MS);
      reconnectTimer = setTimeout(connect, delay);
    };

    const connect = async () => {
      const token = getToken();
      if (!token) return;

      let ticket;
      try {
        ticket = (await createWebSocketTicket()).data.ticket;
      } catch (error) {
        // Tokens expire after 15 minutes. An unlocked identity can simply sign a
        // new challenge; nothing durable is needed for a session refresh.
        if (error?.response?.status === 401 && isUnlocked()) {
          try {
            await signIn(currentIdentity());
            ticket = (await createWebSocketTicket()).data.ticket;
          } catch {
            scheduleReconnect();
            return;
          }
        } else {
          scheduleReconnect();
          return;
        }
      }
      if (closedByUs.current) return;

      const base = import.meta.env.VITE_WS_URL || "ws://localhost:8080";
      if (window.location.protocol === "https:" && base.startsWith("ws:")) {
        setConnected(false);
        return;
      }
      // The ticket is single-use and short-lived. The server selects only
      // timber-v1, so no credential is reflected into a response header.
      const socket = new WebSocket(`${base}/ws`, ["timber-v1", ticket]);
      socketRef.current = socket;

      socket.onopen = () => {
        attemptRef.current = 0;
        setConnected(true);
        // Every receipt sweep goes through this registry rather than through an
        // argument, so a reconcile started by any caller can still send.
        setRealtimeSend(send);
        // Covers messages and relationships that changed while this tab was
        // offline, sleeping, or connected to another API instance.
        reconcileRealtime().catch(() => {});
        reconcileTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) reconcileRealtime().catch(() => {});
        }, 30_000);
      };

      socket.onmessage = async (event) => {
        // Do not let a malformed or unexpectedly large relay event throw from
        // the browser event loop. The server applies the matching wire bound.
        if (typeof event.data !== "string" || event.data.length > MAX_REALTIME_EVENT_BYTES) return;
        let decoded;
        try {
          decoded = JSON.parse(event.data);
        } catch {
          return;
        }
        const { type, payload } = decoded ?? {};
        if (typeof type !== "string" || !payload || typeof payload !== "object") return;
        const store = useChatStore.getState();

        switch (type) {
          case "message.new":
            {
              const received = await receiveMessage(payload);
              if (received && !received.mine) {
                await acknowledgeDelivery(payload.conversation_id);
                // A message landing in a chat the user is already looking at is
                // read the moment it arrives. Without this it was stored seen,
                // so the "mark everything unseen" sweep never found it and the
                // sender sat on two ticks no matter how quickly they replied.
                if (received.isActive && documentVisible()) {
                  await acknowledgeRead(payload.conversation_id);
                }
              }
              if (received) await notifyIncoming({
                ...received,
                conversationId: payload.conversation_id,
                username: payload.username,
              });
            }
            break;
          case "typing.start":
            store.setTyping(payload.conversation_id, payload.username, true);
            clearTimeout(typingTimers.get(payload.conversation_id));
            typingTimers.set(payload.conversation_id, setTimeout(() => {
              store.setTyping(payload.conversation_id, payload.username, false);
            }, 4_000));
            break;
          case "typing.stop":
            clearTimeout(typingTimers.get(payload.conversation_id));
            typingTimers.delete(payload.conversation_id);
            store.setTyping(payload.conversation_id, payload.username, false);
            break;
          case "presence.online":
            store.setUserOnline(payload.user_id, true);
            break;
          case "presence.offline":
            store.setUserOnline(payload.user_id, false);
            break;
          case "receipt.delivered":
            store.markReceipt(payload.message_ids ?? [], "deliveredAt");
            await markReceipt(payload.message_ids ?? [], "deliveredAt");
            break;
          case "receipt.read":
            {
              // Batched now; the single-id shape still arrives from clients
              // running a cached shell from before the change.
              const ids = payload.message_ids ?? (payload.message_id ? [payload.message_id] : []);
              store.markReceipt(ids, "readAt");
              await markReceipt(ids, "readAt");
            }
            break;
          case "error":
            // The relay rejected something we sent. Receipts retry on the next
            // sweep; surfacing it stops the next such bug being invisible.
            console.warn("Timber relay rejected an event:", payload?.scope ?? "unknown");
            break;
          case "call.offer":
          case "call.answer":
          case "call.ice-candidate":
          case "call.ringing":
          case "call.end":
            // SDP and ICE candidates are transient call setup data. They are
            // delivered only to the call controller and never written locally.
            for (const listener of subscribersRef.current) {
              try { listener(type, payload); } catch { /* a call must not break chat sync */ }
            }
            break;
          case "growth.stage_reached":
            store.showLevelUp(payload);
            break;
          case "referral.joined":
            // Someone accepted an invite; refresh so the new auto-friendship
            // appears without a reload. Invites never award growth points.
            try {
              store.setFriends((await getFriends()).data);
              store.setMe((await getCurrentUser()).data);
              await reconcileRealtime();
            } catch {
              /* offline; the next bootstrap reconciles */
            }
            break;
          case "friend.request":
          case "friend.accepted":
          case "friend.removed":
            // The social graph changed underneath us; refetch rather than
            // trying to patch it locally.
            try {
              store.setFriends((await getFriends()).data);
              await reconcileRealtime();
            } catch {
              /* offline; the next bootstrap will reconcile */
            }
            // Announced after the refetch, so opening the notification lands on
            // a screen that already shows the request rather than a stale one.
            // A removal is deliberately silent: nobody needs a popup telling
            // them someone left.
            if (type === "friend.request") await notifyFriendRequest(payload);
            if (type === "friend.accepted") await notifyFriendAccepted(payload);
            break;
          default:
            break;
        }
      };

      socket.onclose = () => {
        clearInterval(reconcileTimer);
        setConnected(false);
        socketRef.current = null;
        if (closedByUs.current) return;
        // Exponential backoff, capped, so a server restart does not turn into a
        // reconnect storm from every open tab.
        scheduleReconnect();
      };

      socket.onerror = () => socket.close();
    };

    connect();

    return () => {
      closedByUs.current = true;
      setRealtimeSend(null);
      clearTimeout(reconnectTimer);
      clearInterval(reconcileTimer);
      for (const timeout of typingTimers.values()) clearTimeout(timeout);
      typingTimers.clear();
      socketRef.current?.close();
      socketRef.current = null;
      setConnected(false);
    };
    // `send` is a stable useCallback with no dependencies, so listing it keeps
    // the lint honest without ever re-opening the socket.
  }, [enabled, send]);

  /**
   * Clear our own badge, then tell the sender.
   *
   * One batched frame rather than one per message: the old loop ran straight
   * into the relay's 60-per-minute ceiling on a catch-up, and the receipts it
   * dropped were gone for good because the messages had already been marked.
   */
  const acknowledge = useCallback((conversationId) => markConversationRead(conversationId), []);

  return { send, connected, acknowledge, subscribe };
}
