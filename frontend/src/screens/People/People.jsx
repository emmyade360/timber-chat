// Friends, requests, and search.
//
// Search results carry the state of the relationship so the button always says the
// truthful next action -- including the one-more-try warning after a rejection.

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  getFriends,
  removeFriend,
  respondToFriendRequest,
  searchUsers,
  sendFriendRequest,
  userMessage,
} from "../../lib/api.js";
import { useChatStore } from "../../store/chatStore.js";
import { reconcileRealtime } from "../../lib/sync.js";
import LevelBadge from "../../components/Level/LevelBadge.jsx";

export default function People({ onOpenConversation }) {
  const { friends, pendingReceived, pendingSent, setFriends, onlineUsers, me } = useChatStore();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState("");
  const hasSearchTerm = query.trim().length >= 2;
  const visibleResults = hasSearchTerm ? results : [];

  const refresh = async () => {
    const { data } = await getFriends();
    setFriends(data);
  };

  // Debounced so typing a username does not fire a request per keystroke.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) return undefined;
    const timer = setTimeout(async () => {
      try {
        setResults((await searchUsers(term)).data);
      } catch {
        setResults([]);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const act = async (id, fn) => {
    setBusyId(id);
    setNotice("");
    try {
      await fn();
      await refresh();
      if (query.trim().length >= 2) setResults((await searchUsers(query.trim())).data);
    } catch (error) {
      setNotice(userMessage(error, "Could not update your people list. Please try again."));
    } finally {
      setBusyId(null);
    }
  };

  const accept = (request) =>
    act(request.id, async () => {
      await respondToFriendRequest(request.id, true);
      await reconcileRealtime();
    });

  return (
    <div className="screen">
      <header className="screen-header">
        <h1 className="screen-title">People</h1>
      </header>

      <div className="search-wrap">
        <input
          className="glass-input"
          placeholder="Search by username…"
          autoCapitalize="none"
          spellCheck="false"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {me && <ContactExchange onAdd={async (id) => { await sendFriendRequest(id); await refresh(); }} />}

      {notice && <p className="form-error people-notice">{notice}</p>}

      {visibleResults.length > 0 && (
        <Section title="Search results">
          {visibleResults.map((user) => (
            <Row key={user.id} user={user} online={onlineUsers.has(user.id)}>
              <SearchAction
                user={user}
                busy={busyId === user.id}
                onAdd={() => act(user.id, () => sendFriendRequest(user.id))}
                onOpen={() => onOpenConversation(user.id)}
              />
            </Row>
          ))}
        </Section>
      )}

      {pendingReceived.length > 0 && (
        <Section title={`Requests (${pendingReceived.length})`}>
          {pendingReceived.map((request) => (
            <Row key={request.id} user={request} online={onlineUsers.has(request.user_id)}>
              <div className="row-actions">
                <button
                  className="btn-wood btn-sm"
                  disabled={busyId === request.id}
                  onClick={() => accept(request)}
                >
                  Accept
                </button>
                <button
                  className="btn-ghost btn-sm"
                  disabled={busyId === request.id}
                  onClick={() => act(request.id, () => respondToFriendRequest(request.id, false))}
                >
                  Decline
                </button>
              </div>
            </Row>
          ))}
        </Section>
      )}

      {pendingSent.length > 0 && (
        <Section title="Sent">
          {pendingSent.map((request) => (
            <Row key={request.id} user={request} online={false}>
              <span className="row-note">Pending</span>
            </Row>
          ))}
        </Section>
      )}

      <Section title={`Friends (${friends.length})`}>
        {friends.length === 0 ? (
          <p className="section-empty">
            No friends yet. Search for a username above to send your first request.
          </p>
        ) : (
          friends.map((friend) => (
            <Row key={friend.id} user={friend} online={onlineUsers.has(friend.id)}>
              <div className="row-actions">
                <button
                  className="btn-wood btn-sm"
                  onClick={() => onOpenConversation(friend.id, friend.conversation_id)}
                >
                  Message
                </button>
                <button
                  className="btn-ghost btn-sm"
                  disabled={busyId === friend.id}
                  onClick={() => {
                    if (window.confirm(`Remove @${friend.username}? This deletes your conversation.`)) {
                      act(friend.id, async () => {
                        await removeFriend(friend.id);
                        // The server only needs to notify the other account;
                        // reconcile this tab immediately as well.
                        await reconcileRealtime();
                      });
                    }
                  }}
                >
                  Remove
                </button>
              </div>
            </Row>
          ))
        )}
      </Section>
    </div>
  );
}

function ContactExchange({ onAdd }) {
  const { me } = useChatStore();
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState("");
  const contactCode = `timber-contact/v1:${me.id}`;
  const add = async () => {
    const id = code.trim().replace(/^timber-contact\/v1:/, "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) { setNotice("Paste a valid Timber contact code."); return; }
    try { await onAdd(id); setCode(""); setNotice("Friend request sent. A private chat opens only if they accept."); }
    catch (error) { setNotice(userMessage(error, "Could not send that friend request. Please try again.")); }
  };
  return (
    <section className="panel contact-exchange">
      <h2 className="section-title">Private QR contact exchange</h2>
      <p className="panel-note">This code contains only your public Timber account ID. It does not reveal your keys, location, online state, or contacts.</p>
      <div className="safety-qr"><QRCodeSVG value={contactCode} size={122} includeMargin /></div>
      <div className="field-group"><label className="field-label">Paste a contact code</label><input className="glass-input" value={code} placeholder="timber-contact/v1:…" onChange={(event) => setCode(event.target.value)} /></div>
      <button className="btn-ghost btn-block" onClick={add}>Send friend request</button>
      {notice && <p className="field-ok">{notice}</p>}
    </section>
  );
}

function SearchAction({ user, busy, onAdd, onOpen }) {
  if (user.friend_status === "friends") {
    return (
      <button className="btn-wood btn-sm" onClick={onOpen}>
        Message
      </button>
    );
  }
  if (user.friend_status === "pending") return <span className="row-note">Request sent</span>;
  if (user.friend_status === "incoming") return <span className="row-note">Wants to add you</span>;

  return (
    <div className="row-actions row-actions--stack">
      <button className="btn-wood btn-sm" disabled={busy} onClick={onAdd}>
        {user.friend_status === "rejected" ? "Try once more" : "Add friend"}
      </button>
      {/* The rule is unusual enough that it has to be said out loud. */}
      {user.last_chance && (
        <span className="row-warning">Declined once — if declined again you cannot ask any more.</span>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="people-section">
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}

function Row({ user, online, children }) {
  const name = user.username;
  return (
    <div className="people-row">
      <span className={`avatar avatar--sm ${online ? "avatar--online" : ""}`}>
        {name?.[0]?.toUpperCase() ?? "?"}
      </span>
      <span className="people-row-text">
        <span className="people-row-name">@{name}</span>
        <span className="people-row-level">
          <LevelBadge level={user.level} size={13} />
          {user.level_name}
        </span>
      </span>
      {children}
    </div>
  );
}
