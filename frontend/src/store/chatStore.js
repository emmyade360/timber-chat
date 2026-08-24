// UI state. The durable copy of everything here lives in the encrypted local
// database; this store is the reactive view React renders from.

import { create } from "zustand";

export const useChatStore = create((set, get) => ({
  me: null,
  ladder: null,
  conversations: [],
  messages: {},
  unread: {},
  activeConversationId: null,
  friends: [],
  pendingReceived: [],
  pendingSent: [],
  typing: {},
  onlineUsers: new Set(),
  levelUp: null,
  syncing: false,
  /** True whenever a call is being set up, ringing, or connected. */
  callActive: false,

  setMe: (me) => set({ me }),
  setLadder: (ladder) => set({ ladder }),
  setSyncing: (syncing) => set({ syncing }),
  setCallActive: (callActive) => set({ callActive }),
  setConversations: (conversations) => set({ conversations }),
  removeConversation: (conversationId) =>
    set((state) => {
      const { [conversationId]: _messages, ...messages } = state.messages;
      const { [conversationId]: _unread, ...unread } = state.unread;
      const { [conversationId]: _typing, ...typing } = state.typing;
      return {
        conversations: state.conversations.filter((conversation) => conversation.id !== conversationId),
        messages,
        unread,
        typing,
        activeConversationId: state.activeConversationId === conversationId ? null : state.activeConversationId,
      };
    }),
  setActiveConversation: (activeConversationId) => set({ activeConversationId }),

  setMessages: (conversationId, messages) =>
    set((state) => ({ messages: { ...state.messages, [conversationId]: messages } })),

  appendMessage: (conversationId, message) =>
    set((state) => {
      const existing = state.messages[conversationId] ?? [];
      // The sender receives its own message back from the server; replace the
      // optimistic copy rather than showing it twice.
      const withoutDuplicate = existing.filter(
        (entry) => entry.id !== message.id && entry.id !== message.clientId,
      );
      return {
        messages: {
          ...state.messages,
          [conversationId]: [...withoutDuplicate, message].sort((a, b) => a.createdAt - b.createdAt),
        },
      };
    }),

  prependMessages: (conversationId, older) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: [...older, ...(state.messages[conversationId] ?? [])],
      },
    })),

  setUnread: (conversationId, count) =>
    set((state) => ({ unread: { ...state.unread, [conversationId]: count } })),

  clearUnread: (conversationId) =>
    set((state) => ({ unread: { ...state.unread, [conversationId]: 0 } })),

  setFriends: ({ friends, pending_received, pending_sent }) =>
    set({
      friends: friends ?? [],
      pendingReceived: pending_received ?? [],
      pendingSent: pending_sent ?? [],
    }),

  setTyping: (conversationId, username, isTyping) =>
    set((state) => {
      const next = { ...state.typing };
      if (isTyping) next[conversationId] = username;
      else delete next[conversationId];
      return { typing: next };
    }),

  setUserOnline: (userId, online) =>
    set((state) => {
      const next = new Set(state.onlineUsers);
      if (online) next.add(userId);
      else next.delete(userId);
      return { onlineUsers: next };
    }),

  /**
   * Stamp a receipt on messages this device sent. `field` is `deliveredAt` or
   * `readAt`; read implies delivery, so it fills both.
   */
  markReceipt: (messageIds, field, at = Date.now()) =>
    set((state) => {
      const ids = new Set(messageIds);
      const messages = {};
      for (const [conversationId, list] of Object.entries(state.messages)) {
        messages[conversationId] = list.map((message) => {
          if (!ids.has(message.id) || message[field]) return message;
          const next = { ...message, [field]: at };
          if (field === "readAt" && !next.deliveredAt) next.deliveredAt = at;
          return next;
        });
      }
      return { messages };
    }),

  showLevelUp: (levelUp) => set({ levelUp }),
  dismissLevelUp: () => set({ levelUp: null }),

  conversationById: (id) => get().conversations.find((entry) => entry.id === id) ?? null,

  reset: () =>
    set({
      me: null,
      callActive: false,
      conversations: [],
      messages: {},
      unread: {},
      activeConversationId: null,
      friends: [],
      pendingReceived: [],
      pendingSent: [],
      typing: {},
      onlineUsers: new Set(),
      levelUp: null,
    }),
}));
