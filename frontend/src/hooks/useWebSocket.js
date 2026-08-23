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
import { markConversationRead, receiveMessage, reconcileRealtime } from "../lib/sync.js";
import { getCurrentUser, getFriends } from "../lib/api.js";
import { notifyIncoming } from "../lib/notifications.js";

const MAX_BACKOFF_MS = 15_000;

export function useWebSocket(enabled) {
  const socketRef = useRef(null);
  const attemptRef = useRef(0);
  const closedByUs = useRef(false);
  const subscribersRef = useRef(new Set());
  const [connected, setConnected] = useState(false);

  const send = useCallback((type, payload) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type, payload }));
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
        // Covers messages and relationships that changed while this tab was
        // offline, sleeping, or connected to another API instance.
        reconcileRealtime().catch(() => {});
        reconcileTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) reconcileRealtime().catch(() => {});
        }, 30_000);
      };

      socket.onmessage = async (event) => {
        const { type, payload } = JSON.parse(event.data);
        const store = useChatStore.getState();

        switch (type) {
          case "message.new":
            {
              const received = await receiveMessage(payload);
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
          case "receipt.read":
            store.markRead([payload.message_id]);
            break;
          case "call.offer":
          case "call.answer":
          case "call.ice-candidate":
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
            // Someone accepted an invite; refresh so the profile XP and the new
            // auto-friendship both appear without a reload.
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
      clearTimeout(reconnectTimer);
      clearInterval(reconcileTimer);
      for (const timeout of typingTimers.values()) clearTimeout(timeout);
      typingTimers.clear();
      socketRef.current?.close();
      socketRef.current = null;
      setConnected(false);
    };
  }, [enabled]);

  /** Tell the sender we read their messages, and clear our own badge. */
  const acknowledge = useCallback(
    async (conversationId) => {
      const changed = await markConversationRead(conversationId);
      for (const messageId of changed) {
        send("receipt.read", { conversation_id: conversationId, message_id: messageId });
      }
    },
    [send],
  );

  return { send, connected, acknowledge, subscribe };
}
