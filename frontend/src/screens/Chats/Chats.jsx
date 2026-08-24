// The home screen: every conversation, most recent first.

import { useState } from "react";
import { useChatStore } from "../../store/chatStore.js";
import { timeAgo } from "../../lib/time.js";
import { filterConversations } from "./chatFilter.js";
import LevelBadge from "../../components/Level/LevelBadge.jsx";

function previewText(preview) {
  if (!preview) return "No messages yet";
  if (preview.undecryptable) {
    return preview.reason === "waiting-for-key" ? "Syncing…" : "Could not be decrypted";
  }
  if (preview.payload?.t === "file") return `📎 ${preview.payload.name ?? "Attachment"}`;
  return preview.payload?.body ?? "";
}

export default function Chats({ onOpen, onFindPeople, onInvite, activeConversationId = null }) {
  const { conversations, unread, onlineUsers, syncing } = useChatStore();
  const [query, setQuery] = useState("");
  const visibleConversations = filterConversations(conversations, query);

  return (
    <div className="screen">
      <div className="screen-toolbar">
        <header className="screen-header">
          <h1 className="screen-title">Chats</h1>
          {syncing && <span className="sync-dot" title="Syncing" />}
        </header>
        <div className="search-wrap">
          <input
            className="glass-input"
            type="search"
            placeholder="Search your friends…"
            aria-label="Search your chats by friend username"
            autoCapitalize="none"
            spellCheck="false"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      {conversations.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">🌲</span>
          <h2 className="empty-title">{syncing ? "Syncing…" : "No conversations yet"}</h2>
          <p className="empty-sub">
            Find someone by username and send a friend request. Once you both accept, you can talk.
          </p>
          <div className="empty-actions">
            <button className="btn-wood" onClick={onFindPeople}>
              Find people
            </button>
            <button className="btn-ghost" onClick={onInvite}>
              Invite a friend
            </button>
          </div>
          <p className="empty-hint">
            Growth comes from steady, mutual connection — never invite counts.
          </p>
        </div>
      ) : visibleConversations.length === 0 ? (
        <div className="empty-state chat-filter-empty">
          <span className="empty-icon">⌕</span>
          <h2 className="empty-title">No matching friends</h2>
          <p className="empty-sub">Try another username, or clear the search to see every chat.</p>
          <button className="btn-ghost" onClick={() => setQuery("")}>Clear search</button>
        </div>
      ) : (
        <ul className="chat-list">
          {visibleConversations.map((conversation) => {
          const count = unread[conversation.id] ?? 0;
          const online = onlineUsers.has(conversation.peerId);
          return (
            <li key={conversation.id}>
              <button
                className={`chat-row ${conversation.id === activeConversationId ? "chat-row--active" : ""}`}
                aria-current={conversation.id === activeConversationId ? "true" : undefined}
                onClick={() => onOpen(conversation.id)}
              >
                <span className={`avatar ${online ? "avatar--online" : ""}`}>
                  {conversation.peerUsername?.[0]?.toUpperCase() ?? "?"}
                </span>
                <span className="chat-row-body">
                  <span className="chat-row-top">
                    <span className="chat-row-name">
                      {conversation.peerUsername}
                      {conversation.peerLevel && (
                        <LevelBadge level={conversation.peerLevel} size={14} name={conversation.peerLevelName} className="name-gem" />
                      )}
                    </span>
                    <span className="chat-row-time">
                      {timeAgo(conversation.preview?.createdAt ?? conversation.updatedAt)}
                    </span>
                  </span>
                  <span className="chat-row-bottom">
                    <span className={`chat-row-preview ${count ? "chat-row-preview--unread" : ""}`}>
                      {previewText(conversation.preview)}
                    </span>
                    {count > 0 && <span className="unread-badge">{count > 99 ? "99+" : count}</span>}
                  </span>
                </span>
              </button>
            </li>
          );
          })}
        </ul>
      )}
    </div>
  );
}
