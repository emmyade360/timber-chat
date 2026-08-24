// People: who you are actually talking to, with requests and the full friend
// list one tap away.
//
// The default view is deliberately the narrow one. Most of the time the answer
// to "who am I here for" is someone you already have a conversation with, so
// that is what the screen opens on; the friend list and the request queue are
// browsing surfaces, and they live behind their own icons rather than pushing
// the live conversations down the page.
//
// Search cuts across all three: a term always shows results, whichever view is
// selected, because looking someone up is not a fourth mode.

import { useEffect, useMemo, useState } from "react";
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
import { timeAgo } from "../../lib/time.js";

function normalizedSearchTerm(value) {
  return value.trim().replace(/^@+/, "");
}

/** The three things this screen can be showing, aside from search results. */
const VIEWS = { active: "active", requests: "requests", friends: "friends" };

export default function People({ onOpenConversation }) {
  const { friends, pendingReceived, pendingSent, setFriends, onlineUsers, me, conversations, unread } =
    useChatStore();
  const [view, setView] = useState(VIEWS.active);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searchState, setSearchState] = useState("idle");
  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState("");
  const term = normalizedSearchTerm(query);
  const hasSearchTerm = term.length >= 2;
  const visibleResults = hasSearchTerm ? results : [];

  /**
   * Friends with a conversation that has actually started, newest first.
   *
   * A conversation row exists from the moment a request is accepted, so the
   * test for "ongoing" is whether anything has been said in it. Joining onto
   * the friend record is what supplies the growth stage the row displays.
   */
  const ongoing = useMemo(() => {
    const byPeer = new Map(conversations.map((entry) => [entry.peerId, entry]));
    return friends
      .map((friend) => ({ friend, conversation: byPeer.get(friend.id) }))
      .filter((entry) => entry.conversation?.preview)
      .sort((a, b) => (b.conversation.updatedAt ?? 0) - (a.conversation.updatedAt ?? 0));
  }, [conversations, friends]);

  const refresh = async () => {
    const { data } = await getFriends();
    setFriends(data);
  };

  // Debounced so typing a username does not fire a request per keystroke, and
  // guarded so a slow response for an older query cannot replace newer results.
  useEffect(() => {
    const searchTerm = normalizedSearchTerm(query);
    if (searchTerm.length < 2) return undefined;
    let active = true;
    const timer = setTimeout(async () => {
      setSearchState("searching");
      try {
        const response = await searchUsers(searchTerm);
        if (!active) return;
        setResults(response.data);
        setSearchState("done");
      } catch {
        if (!active) return;
        setResults([]);
        setSearchState("error");
      }
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);

  const act = async (id, fn, successMessage = "") => {
    setBusyId(id);
    setNotice("");
    try {
      const result = await fn();
      await refresh();
      if (term.length >= 2) setResults((await searchUsers(term)).data);
      if (successMessage) setNotice(successMessage);
      return result;
    } catch (error) {
      setNotice(userMessage(error, "Could not update your people list. Please try again."));
      return null;
    } finally {
      setBusyId(null);
    }
  };

  const accept = async (request) => {
    const accepted = await act(request.id, async () => {
      const response = await respondToFriendRequest(request.id, true);
      await reconcileRealtime();
      return response.data;
    });
    // Acceptance created this conversation atomically on the server. Opening it
    // right away makes the next step clear without ever allowing an open DM.
    if (accepted?.conversation_id) {
      onOpenConversation(request.user_id, accepted.conversation_id);
    }
  };

  const requestFriend = (userId) =>
    act(
      userId,
      () => sendFriendRequest(userId),
      "Friend request sent. You can chat once they accept.",
    );

  // Tapping the active icon returns to the conversations the screen opens on,
  // so neither icon is a one-way door.
  const toggleView = (next) => setView((current) => (current === next ? VIEWS.active : next));

  const changeQuery = (value) => {
    setQuery(value);
    setResults([]);
    setSearchState(normalizedSearchTerm(value).length >= 2 ? "searching" : "idle");
  };

  return (
    <div className="screen">
      <div className="screen-toolbar">
        <header className="screen-header">
          <h1 className="screen-title">People</h1>
          <div className="people-views" role="group" aria-label="People views">
            <ViewIcon
              active={view === VIEWS.requests}
              badge={pendingReceived.length}
              label="Friend requests"
              onClick={() => toggleView(VIEWS.requests)}
            >
              <RequestIcon />
            </ViewIcon>
            <ViewIcon
              active={view === VIEWS.friends}
              badge={0}
              label="Friend list"
              onClick={() => toggleView(VIEWS.friends)}
            >
              <FriendsIcon />
            </ViewIcon>
          </div>
        </header>
        <div className="search-wrap">
          <input
            className="glass-input"
            type="search"
            placeholder="Find new people by username…"
            aria-label="Find new people by username"
            autoCapitalize="none"
            spellCheck="false"
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
          />
        </div>
      </div>

      {notice && <p className="form-error people-notice">{notice}</p>}

      {hasSearchTerm && (
        <Section title={searchState === "done" ? `People found (${visibleResults.length})` : "Find people"}>
          <div className="search-feedback" aria-live="polite">
            {searchState === "searching" && "Searching Timber…"}
            {searchState === "error" && "Search is unavailable right now. Please try again."}
            {searchState === "done" && visibleResults.length === 0 && "No Timber users match that username."}
          </div>
          {visibleResults.map((user) => (
            <Row
              key={user.id}
              user={user}
              online={onlineUsers.has(user.id)}
              footnote={user.last_chance
                ? "Declined once — if declined again you cannot ask any more."
                : null}
            >
              <SearchAction
                user={user}
                busy={busyId === user.id}
                onAdd={() => requestFriend(user.id)}
                onOpen={() => onOpenConversation(user.id)}
              />
            </Row>
          ))}
        </Section>
      )}

      {!hasSearchTerm && view === VIEWS.active && (
        <Section title={`Conversations (${ongoing.length})`}>
          {ongoing.length === 0 ? (
            <p className="section-empty">
              No conversations yet. Open your friend list to start one, or search for a
              username above to add someone.
            </p>
          ) : (
            ongoing.map(({ friend, conversation }) => (
              <Row
                key={conversation.id}
                user={friend}
                online={onlineUsers.has(friend.id)}
                onOpen={() => onOpenConversation(friend.id, conversation.id)}
              >
                <span className="row-when">
                  {unread[conversation.id] > 0 && (
                    <span className="unread-badge">{unread[conversation.id] > 9 ? "9+" : unread[conversation.id]}</span>
                  )}
                  {conversation.updatedAt ? timeAgo(conversation.updatedAt) : ""}
                </span>
              </Row>
            ))
          )}
        </Section>
      )}

      {!hasSearchTerm && view === VIEWS.requests && (
        <>
          <Section title={`Requests (${pendingReceived.length})`}>
            {pendingReceived.length === 0 ? (
              <p className="section-empty">No one is waiting on an answer from you.</p>
            ) : (
              pendingReceived.map((request) => (
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
              ))
            )}
          </Section>

          {pendingSent.length > 0 && (
            <Section title={`Sent (${pendingSent.length})`}>
              {pendingSent.map((request) => (
                <Row key={request.id} user={request} online={false}>
                  <span className="row-note">Pending</span>
                </Row>
              ))}
            </Section>
          )}
        </>
      )}

      {!hasSearchTerm && view === VIEWS.friends && (
        <>
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

          {/* Adding someone belongs with the list of who you have already added. */}
          {me && <ContactExchange onAdd={async (id) => { await sendFriendRequest(id); await refresh(); }} />}
        </>
      )}
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
    <div className="row-actions">
      <button className="btn-wood btn-sm" disabled={busy} onClick={onAdd}>
        {busy ? "Sending…" : user.friend_status === "rejected" ? "Try once more" : "Add friend"}
      </button>
    </div>
  );
}

/**
 * One of the two view switches in the header.
 *
 * These are toggles rather than links, so `aria-pressed` is what tells a screen
 * reader which surface is showing; the badge count is folded into the label for
 * the same reason.
 */
function ViewIcon({ active, badge, label, onClick, children }) {
  return (
    <button
      type="button"
      className={`people-view ${active ? "people-view--active" : ""}`}
      aria-pressed={active}
      aria-label={badge > 0 ? `${label}, ${badge} waiting` : label}
      title={label}
      onClick={onClick}
    >
      {children}
      {badge > 0 && <span className="people-view-badge">{badge > 9 ? "9+" : badge}</span>}
    </button>
  );
}

/** A person with a plus: the request queue. */
function RequestIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9.5" cy="8" r="3.6" />
      <path d="M3.4 20c0-3.3 2.7-5.6 6.1-5.6 1.2 0 2.3.3 3.2.8" />
      <path d="M17.5 14.6v5.2M14.9 17.2h5.2" />
    </svg>
  );
}

/** Two people: the full friend list. */
function FriendsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3.4" />
      <path d="M2.9 19.8c0-3.2 2.7-5.4 6.1-5.4s6.1 2.2 6.1 5.4" />
      <path d="M16.2 5.1a3.4 3.4 0 0 1 0 6.5" />
      <path d="M17.6 14.7c2.2.5 3.7 2.2 3.7 4.5" />
    </svg>
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

/**
 * One person in a list: identity on the left, the single next action on the
 * right, and an optional note on its own line so a long warning never squeezes
 * the button into an unreadable column.
 */
function Row({ user, online, children, footnote, onOpen }) {
  const name = user.username;
  // A conversation row is the whole target; a browsing row is not clickable and
  // keeps its buttons as the only actions.
  const Identity = onOpen ? "button" : "span";
  return (
    <div className="people-row">
      <Identity
        className={`people-row-identity ${onOpen ? "people-row-identity--open" : ""}`}
        {...(onOpen ? { type: "button", onClick: onOpen, "aria-label": `Open your chat with @${name}` } : {})}
      >
        <span className={`avatar avatar--sm ${online ? "avatar--online" : ""}`}>
          {name?.[0]?.toUpperCase() ?? "?"}
        </span>
        <span className="people-row-text">
          <span className="people-row-name">
            @{name}
            <LevelBadge level={user.level} size={14} name={user.level_name} className="name-gem" />
          </span>
          <span className="people-row-level">{user.level_name}</span>
        </span>
      </Identity>
      {children}
      {footnote && <p className="row-footnote">{footnote}</p>}
    </div>
  );
}
