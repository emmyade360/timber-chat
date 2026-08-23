// The home screen: every conversation, most recent first.

import { useChatStore } from "../../store/chatStore.js";
import { timeAgo } from "../../lib/time.js";

function previewText(preview) {
  if (!preview) return "No messages yet";
  if (preview.undecryptable) {
    return preview.reason === "waiting-for-key" ? "Syncing…" : "Could not be decrypted";
  }
  if (preview.payload?.t === "file") return `📎 ${preview.payload.name ?? "Attachment"}`;
  return preview.payload?.body ?? "";
}

export default function Chats({ onOpen, onFindPeople, onInvite }) {
  const { conversations, unread, onlineUsers, syncing } = useChatStore();

  if (conversations.length === 0) {
    return (
      <div className="screen">
        <header className="screen-header">
          <h1 className="screen-title">Chats</h1>
        </header>
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
      </div>
    );
  }

  return (
    <div className="screen">
      <header className="screen-header">
        <h1 className="screen-title">Chats</h1>
        {syncing && <span className="sync-dot" title="Syncing" />}
      </header>

      <ul className="chat-list">
        {conversations.map((conversation) => {
          const count = unread[conversation.id] ?? 0;
          const online = onlineUsers.has(conversation.peerId);
          return (
            <li key={conversation.id}>
              <button className="chat-row" onClick={() => onOpen(conversation.id)}>
                <span className={`avatar ${online ? "avatar--online" : ""}`}>
                  {conversation.peerUsername?.[0]?.toUpperCase() ?? "?"}
                </span>
                <span className="chat-row-body">
                  <span className="chat-row-top">
                    <span className="chat-row-name">{conversation.peerUsername}</span>
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
    </div>
  );
}
