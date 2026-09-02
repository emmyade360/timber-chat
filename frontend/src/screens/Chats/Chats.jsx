// The home screen: every conversation, most recent first.

import { useEffect, useState } from "react";
import { useChatStore } from "../../store/chatStore.js";
import { searchMessages } from "../../db/localStore.js";
import { timeAgo } from "../../lib/time.js";
import { filterConversations } from "./chatFilter.js";
import LevelBadge from "../../components/Level/LevelBadge.jsx";
import SecurePrompt from "../../components/Secure/SecurePrompt.jsx";
import StreakFlame from "../../components/Streak/StreakFlame.jsx";
import { Icons } from "../../components/Settings/icons.jsx";

function previewText(preview) {
  if (!preview) return "No messages yet";
  if (preview.undecryptable) {
    return preview.reason === "waiting-for-key" ? "Syncing…" : "Could not be decrypted";
  }
  if (preview.payload?.t === "file") return `📎 ${preview.payload.name ?? "Attachment"}`;
  return preview.payload?.body ?? "";
}

export default function Chats({ onOpen, onFindPeople, onInvite, onSecureAccount, activeConversationId = null }) {
  const { conversations, unread, onlineUsers, syncing, streaks } = useChatStore();
  const [query, setQuery] = useState("");
  // Results are stored with the term that produced them, so a stale answer for
  // a term the user has already moved on from is never rendered.
  const [found, setFound] = useState({ term: "", results: [] });
  const visibleConversations = filterConversations(conversations, query);
  const term = query.trim();

  // Search every conversation, not just the names. `searchMessages` has always
  // read the whole encrypted store; until now the only caller threw away
  // everything outside the thread that happened to be open.
  useEffect(() => {
    if (term.length < 2) return undefined;
    // Opening each envelope is real work, so a slow result for an earlier term
    // has to be discarded as well as cancelled.
    let ignore = false;
    const timer = setTimeout(() => {
      searchMessages(term, { limit: 30 })
        .then((results) => { if (!ignore) setFound({ term, results }); })
        .catch(() => { if (!ignore) setFound({ term, results: [] }); });
    }, 180);
    return () => { ignore = true; clearTimeout(timer); };
  }, [term]);

  const matches = term.length >= 2 && found.term === term ? found.results : [];

  const nameFor = (conversationId) =>
    conversations.find((entry) => entry.id === conversationId)?.peerUsername ?? "Private contact";

  return (
    <div className="screen">
      <div className="screen-toolbar">
        <header className="screen-header">
          <span className="chat-list-mark" aria-hidden="true">{Icons.shield}</span>
          <h1 className="screen-title">Timber</h1>
          {syncing && <span className="sync-dot" title="Syncing" />}
          <button className="screen-header-action chat-list-compose" onClick={onFindPeople} aria-label="Start a private connection" title="Find people">✎</button>
        </header>
        <div className="search-wrap">
          <input
            className="glass-input"
            type="search"
            placeholder="Search chats and messages…"
            aria-label="Search your chats by friend username, or your messages by content"
            autoCapitalize="none"
            spellCheck="false"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      <SecurePrompt conversationCount={conversations.length} onStart={onSecureAccount} />

      {matches.length > 0 && (
        <section className="chat-search-matches">
          <h2 className="section-title">Messages ({matches.length})</h2>
          <ul className="chat-list">
            {matches.map((message) => (
              <li key={message.id}>
                <button className="chat-row" onClick={() => onOpen(message.conversationId)}>
                  <span className="avatar">{nameFor(message.conversationId)[0]?.toUpperCase() ?? "?"}</span>
                  <span className="chat-row-body">
                    <span className="chat-row-top">
                      <span className="chat-row-name">{nameFor(message.conversationId)}</span>
                      <span className="chat-row-time">{timeAgo(message.createdAt)}</span>
                    </span>
                    <span className="chat-row-bottom">
                      <span className="chat-row-preview">{previewText(message)}</span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

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
            Growth comes from talking to people, keeping streaks, and inviting friends.
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
                      <StreakFlame streak={streaks[conversation.peerId]} />
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
