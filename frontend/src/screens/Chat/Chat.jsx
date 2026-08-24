// A private 1:1 conversation. New interaction features are encrypted control
// envelopes; this component only receives already-decrypted local projections.

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useChatStore } from "../../store/chatStore.js";
import { currentIdentity } from "../../crypto/session.js";
import { decryptFile, encryptFile, payloads } from "../../crypto/envelope.js";
import { safetyFingerprint } from "../../crypto/identity.js";
import {
  getMeta,
  getPeer,
  savedMessageIds,
  savedMessages,
  searchMessages,
  setMeta,
  toggleSavedMessage,
} from "../../db/localStore.js";
import { downloadEncrypted, uploadEncrypted, userMessage } from "../../lib/api.js";
import { loadConversation, loadOlder, prepareOutgoingPayload } from "../../lib/sync.js";
import { notificationSettings, setChatNotification } from "../../lib/notifications.js";
import { timeAgo } from "../../lib/time.js";

const TYPING_IDLE_MS = 1500;
const VOICE_NOTE_LIFETIME_MS = 24 * 60 * 60 * 1000;
function labelForPayload(payload) {
  if (payload?.t === "file") return payload.kind === "voice" ? "Voice note" : `Attachment: ${payload.name ?? "file"}`;
  if (payload?.t === "decision") return `${payload.kind === "poll" ? "Poll" : "Decision"}: ${payload.prompt}`;
  if (payload?.t === "call") return `${payload.mode === "video" ? "Video" : "Audio"} call`;
  return payload?.body ?? "";
}

export default function Chat({ conversationId, send, onBack, onStartCall, call }) {
  const { messages, conversations, typing, onlineUsers } = useChatStore();
  const [text, setText] = useState("");
  const [sendError, setSendError] = useState("");
  const [safetyNumber, setSafetyNumber] = useState("");
  const [showSafety, setShowSafety] = useState(false);
  const [verified, setVerified] = useState(false);
  const [replyTo, setReplyTo] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [saved, setSaved] = useState(new Set());
  const [savedOpen, setSavedOpen] = useState(false);
  const [savedEntries, setSavedEntries] = useState([]);
  const [recording, setRecording] = useState(false);
  const [notificationsMuted, setNotificationsMuted] = useState(false);
  const scrollRef = useRef(null);
  const typingTimer = useRef(null);
  const isTyping = useRef(false);
  const fileInput = useRef(null);
  const recorder = useRef(null);
  const recordingStartedAt = useRef(0);

  const conversation = conversations.find((entry) => entry.id === conversationId);
  const list = messages[conversationId] ?? [];
  const me = currentIdentity().userId;
  const peerTyping = typing[conversationId];
  const secure = !conversation?.securityError;

  useEffect(() => { loadConversation(conversationId); }, [conversationId]);
  useEffect(() => {
    savedMessageIds().then(setSaved).catch(() => {});
    notificationSettings().then((settings) => setNotificationsMuted(settings.chats?.[conversationId] === "muted")).catch(() => {});
    return () => recorder.current?.stream?.getTracks().forEach((track) => track.stop());
  }, [conversationId]);

  useEffect(() => {
    let live = true;
    const loadSafety = async () => {
      if (!conversation?.peerId || conversation.securityError) return;
      try {
        const peer = await getPeer(conversation.peerId);
        if (!peer || !live) return;
        const identity = currentIdentity();
        setSafetyNumber(safetyFingerprint({
          userId: identity.userId,
          identityPk: identity.identityPk,
          peerUserId: peer.id,
          peerIdentityPk: peer.identity_pk,
        }));
        setVerified(Boolean(await getMeta(`safety:${peer.id}`)));
      } catch {
        // A peer with an invalid binding cannot be used to encrypt a new message.
      }
    };
    loadSafety();
    return () => { live = false; };
  }, [conversation?.peerId, conversation?.securityError]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [list.length, peerTyping]);

  useEffect(() => {
    if (!searchTerm.trim()) return undefined;
    const timer = setTimeout(() => {
      searchMessages(searchTerm).then((all) => {
        setSearchResults(all.filter((message) => message.conversationId === conversationId));
      }).catch(() => setSearchResults([]));
    }, 180);
    return () => clearTimeout(timer);
  }, [searchTerm, conversationId]);

  const stopTyping = () => {
    clearTimeout(typingTimer.current);
    if (isTyping.current) {
      isTyping.current = false;
      send("typing.stop", { conversation_id: conversationId });
    }
  };

  const handleChange = (value) => {
    setText(value);
    if (!isTyping.current) {
      isTyping.current = true;
      send("typing.start", { conversation_id: conversationId });
    }
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(stopTyping, TYPING_IDLE_MS);
  };

  const sendPayload = async (payload, { attachmentId = null, attachmentExpiresAt = null } = {}) => {
    const { clientId, envelope } = await prepareOutgoingPayload(conversationId, payload);
    const delivered = send("message.send", {
      conversation_id: conversationId,
      client_id: clientId,
      attachment_id: attachmentId,
      attachment_expires_at: attachmentExpiresAt,
      ...envelope,
    });
    if (!delivered) setSendError("Offline — this stays sealed on this device until you reconnect.");
    return clientId;
  };

  const submit = async () => {
    const body = text.trim();
    if (!body || !secure) return;
    setSendError("");
    stopTyping();
    try {
      await sendPayload(payloads.text(body, { replyTo: replyTo?.id }));
      setText("");
      setReplyTo(null);
    } catch (error) {
      setSendError(userMessage(error, "Could not send that message. Please try again."));
    }
  };

  const sendControl = async (payload) => {
    try { await sendPayload(payload); } catch (error) { setSendError(userMessage(error, "Could not update that message. Please try again.")); }
  };

  const attachFile = async (file, kind = "file", durationMs = null) => {
    if (!file || !secure) return;
    setSendError("");
    if (file.size > 10 * 1024 * 1024) {
      setSendError("Files must be 10 MB or smaller.");
      return;
    }
    try {
      const { blob, key } = encryptFile(new Uint8Array(await file.arrayBuffer()));
      const { data } = await uploadEncrypted(blob);
      const expiresAt = kind === "voice" ? new Date(Date.now() + VOICE_NOTE_LIFETIME_MS).toISOString() : null;
      const payload = payloads.file({
        attachmentId: data.attachment_id,
        key,
        name: file.name || "voice-note.webm",
        mime: file.type || "application/octet-stream",
        size: file.size,
        kind,
        durationMs,
        expiresAt,
      });
      await sendPayload(payload, { attachmentId: data.attachment_id, attachmentExpiresAt: expiresAt });
    } catch (error) {
      setSendError(userMessage(error, "Could not attach that file. Please try again."));
    }
  };

  const toggleVoice = async () => {
    if (recording && recorder.current) {
      recorder.current.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      const media = new MediaRecorder(stream);
      recordingStartedAt.current = Date.now();
      media.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      media.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        recorder.current = null;
        const file = new File([new Blob(chunks, { type: media.mimeType || "audio/webm" })], "voice-note.webm", {
          type: media.mimeType || "audio/webm",
        });
        await attachFile(file, "voice", Date.now() - recordingStartedAt.current);
      };
      recorder.current = media;
      media.start();
      setRecording(true);
    } catch {
      setSendError("Microphone access is needed to record a voice note.");
    }
  };

  const downloadAttachment = async (message) => {
    try {
      const { data } = await downloadEncrypted(message.payload.attachment_id);
      const bytes = decryptFile(new Uint8Array(data), message.payload.key);
      const blob = new Blob([bytes], { type: message.payload.mime || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = message.payload.name || "attachment";
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setSendError("This encrypted attachment is unavailable or has expired.");
    }
  };

  const saveMessage = async (message) => {
    const isSaved = await toggleSavedMessage(message);
    setSaved((current) => {
      const next = new Set(current);
      if (isSaved) next.add(message.id); else next.delete(message.id);
      return next;
    });
  };

  const showSaved = async () => {
    setSavedEntries(await savedMessages());
    setSavedOpen(true);
  };

  const toggleChatNotifications = async () => {
    const next = !notificationsMuted;
    await setChatNotification(conversationId, next ? "muted" : "default");
    setNotificationsMuted(next);
  };

  const onScroll = async (event) => {
    if (event.currentTarget.scrollTop < 60) {
      const node = event.currentTarget;
      const before = node.scrollHeight;
      if (await loadOlder(conversationId)) requestAnimationFrame(() => { node.scrollTop = node.scrollHeight - before; });
    }
  };

  const startCall = async (mode) => {
    if (!secure || !onStartCall) return;
    try {
      await onStartCall({
        conversationId,
        mode,
        peerName: conversation?.peerUsername ?? "friend",
      });
    } catch (error) {
      setSendError(userMessage(error, "Could not start this call. Please try again."));
    }
  };

  return (
    <div className="screen chat-screen">
      <header className="chat-header">
        <div className="chat-header-identity">
          <button className="icon-btn" onClick={onBack} aria-label="Back">‹</button>
          <span className={`avatar avatar--sm ${onlineUsers.has(conversation?.peerId) ? "avatar--online" : ""}`}>{conversation?.peerUsername?.[0]?.toUpperCase() ?? "?"}</span>
          <div className="chat-header-text"><span className="chat-header-name">{conversation?.peerUsername}</span><span className="chat-header-sub">{peerTyping ? "typing…" : onlineUsers.has(conversation?.peerId) ? "online" : "offline"}</span></div>
        </div>
        <div className="chat-header-actions" aria-label="Conversation actions">
          <button className="chat-header-action" disabled={!secure || call?.phase !== "idle"} onClick={() => startCall("audio")} aria-label="Start audio call" title="Start low-data audio call">☎</button>
          <button className="chat-header-action" disabled={!secure || call?.phase !== "idle"} onClick={() => startCall("video")} aria-label="Start video call" title="Start video call">▣</button>
          <button className="chat-header-action" onClick={showSaved} aria-label="View private saved messages">★</button>
          <button className="chat-header-action" onClick={toggleChatNotifications} aria-label={notificationsMuted ? "Turn on chat notifications" : "Mute chat notifications"}>{notificationsMuted ? "🔕" : "🔔"}</button>
          <button className="chat-header-action" onClick={() => setSearchOpen((open) => !open)} aria-label="Search this encrypted conversation">⌕</button>
          {safetyNumber && <button className="chat-header-action" onClick={() => setShowSafety(true)} aria-label="Verify contact safety number">{verified ? "🔒" : "🔐"}</button>}
        </div>
      </header>

      {searchOpen && <div className="chat-search"><input className="glass-input" autoFocus placeholder="Search encrypted messages on this device" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} />
        {searchTerm && <div className="chat-search-results">{searchResults.length ? searchResults.map((message) => <button key={message.id} onClick={() => { setSearchOpen(false); setSearchTerm(""); }}>{labelForPayload(message.payload)}</button>) : <span>No local matches</span>}</div>}
      </div>}

      <div className="message-scroll" ref={scrollRef} onScroll={onScroll}>
        <p className="e2e-notice">🔒 Messages are encrypted on your device. Not even Timber can read them.</p>
        {conversation?.securityError && <p className="onboard-warning">{conversation.securityError}</p>}
        {list.map((message) => {
          const mine = message.senderId === me;
          const replied = list.find((entry) => entry.id === message.payload?.reply_to);
          return <div key={message.id} className={`bubble-row ${mine ? "bubble-row--mine" : ""}`}>
            <div className={`bubble ${mine ? "bubble--mine" : "bubble--theirs"} ${message.deleted || message.expired ? "bubble--muted" : ""}`}>
              {message.undecryptable ? <span className="bubble-undecryptable">{message.reason === "waiting-for-key" ? "Waiting for this contact's key…" : "This message could not be decrypted."}</span> : message.deleted ? <span className="bubble-undecryptable">This message was deleted for everyone.</span> : message.expired ? <span className="bubble-undecryptable">This postcard has expired.</span> : <MessageContent message={message} replied={replied} onDownload={downloadAttachment} onVote={(value) => sendControl(payloads.decisionVote(message.id, value))} />}
              {message.pinned && <span className="message-pin">📌 Pinned</span>}
              {Object.entries(message.reactions ?? {}).map(([emoji, people]) => <span className="reaction" key={emoji}>{emoji} {people.length}</span>)}
              <span className="bubble-meta">{message.payload?.scheduled_at && message.pending ? `Scheduled ${new Date(message.payload.scheduled_at).toLocaleString()} · ` : ""}{timeAgo(message.createdAt)}{mine && <span className="bubble-tick">{message.pending ? "🕓" : message.readByPeer ? "✓✓" : "✓"}</span>}</span>
              {!message.undecryptable && !message.deleted && !message.expired && <div className="message-tools">
                <button onClick={() => setReplyTo(message)} aria-label="Reply">↩</button>
                <button onClick={() => sendControl(payloads.reaction(message.id, "❤️"))} aria-label="React with heart">♥</button>
                <button onClick={() => saveMessage(message)} aria-label="Save message">{saved.has(message.id) ? "★" : "☆"}</button>
                <button onClick={() => sendControl(payloads.pin(message.id, !message.pinned))} aria-label="Toggle shared pin">📌</button>
                {mine && message.payload?.t === "text" && <button onClick={() => { const body = window.prompt("Edit message", message.payload.body); if (body?.trim()) sendControl(payloads.edit(message.id, body.trim())); }} aria-label="Edit message">✎</button>}
                {mine && <button onClick={() => window.confirm("Delete this for everyone?") && sendControl(payloads.delete(message.id))} aria-label="Delete for everyone">×</button>}
              </div>}
            </div>
          </div>;
        })}
        {peerTyping && <div className="bubble-row"><div className="bubble bubble--theirs typing-bubble"><span /><span /><span /></div></div>}
      </div>

      {sendError && <p className="chat-send-error">{sendError}</p>}
      {replyTo && <div className="reply-bar"><span>Replying to {labelForPayload(replyTo.payload).slice(0, 70)}</span><button onClick={() => setReplyTo(null)} aria-label="Cancel reply">×</button></div>}
      <div className="composer">
        <input ref={fileInput} className="sr-only" type="file" onChange={(event) => { attachFile(event.target.files?.[0]); event.target.value = ""; }} />
        <button className="composer-attach" disabled={!secure} onClick={() => fileInput.current?.click()} aria-label="Attach encrypted file">＋</button>
        <button className={`composer-attach ${recording ? "composer-attach--recording" : ""}`} disabled={!secure} onClick={toggleVoice} aria-label={recording ? "Stop recording" : "Record encrypted voice note"}>{recording ? "■" : "●"}</button>
        <input className="glass-input composer-input" placeholder="Say something…" value={text} onChange={(event) => handleChange(event.target.value)} onKeyDown={(event) => event.key === "Enter" && submit()} disabled={!secure} />
        <button className="btn-wood composer-send" onClick={submit} disabled={!secure || !text.trim()}>Send</button>
      </div>

      {showSafety && <div className="modal-backdrop" onClick={() => setShowSafety(false)}><div className="modal glass-panel" onClick={(event) => event.stopPropagation()}><h3 className="modal-title">Contact safety number</h3><p className="panel-note">Compare this number with @{conversation?.peerUsername} in person or over another trusted channel.</p><code className="safety-number">{safetyNumber}</code><div className="safety-qr" aria-label="Safety number QR code"><QRCodeSVG value={`timber-safety/v1:${conversation.peerId}:${safetyNumber.replaceAll(" ", "")}`} size={156} includeMargin /></div>{verified ? <p className="field-ok">You marked this contact as verified on this device.</p> : <button className="btn-wood btn-block" onClick={async () => { await setMeta(`safety:${conversation.peerId}`, { verifiedAt: Date.now() }); setVerified(true); }}>Numbers match</button>}<button className="btn-ghost btn-block" onClick={() => setShowSafety(false)}>Done</button></div></div>}
      {savedOpen && <div className="modal-backdrop" onClick={() => setSavedOpen(false)}><div className="modal glass-panel" onClick={(event) => event.stopPropagation()}><h3 className="modal-title">Saved messages</h3>{savedEntries.length ? <div className="saved-list">{savedEntries.map((message) => <p key={message.id}>{labelForPayload(message.payload)}</p>)}</div> : <p className="panel-note">No saved messages on this device yet.</p>}<p className="panel-note">Saved messages are encrypted and private to this device.</p><button className="btn-ghost btn-block" onClick={() => setSavedOpen(false)}>Done</button></div></div>}
    </div>
  );
}

function MessageContent({ message, replied, onDownload, onVote }) {
  const payload = message.payload ?? {};
  if (payload.reply_to) return <><span className="reply-quote">↩ {replied ? labelForPayload(replied.payload).slice(0, 70) : "Reply"}</span><MessageContent message={{ ...message, payload: { ...payload, reply_to: null } }} replied={null} onDownload={onDownload} onVote={onVote} /></>;
  if (payload.t === "file") return <button className="attachment-card" onClick={() => onDownload(message)}>{payload.kind === "voice" ? "🎙" : "📎"} {payload.name ?? "Encrypted attachment"}{payload.kind === "voice" && payload.duration_ms ? ` · ${Math.ceil(payload.duration_ms / 1000)}s` : ""}</button>;
  if (payload.t === "decision") return <div className="decision-card"><strong>{payload.kind === "poll" ? "Poll" : "Decision"}</strong><span>{payload.prompt}</span>{payload.options?.length > 0 && <div className="decision-options">{payload.options.map((option) => <button key={option} onClick={() => onVote(option)}>{option} {Object.values(message.votes ?? {}).filter((vote) => vote === option).length || ""}</button>)}</div>}</div>;
  if (payload.t === "call") return <CallCard payload={payload} />;
  return <span className="bubble-body">{payload.body}</span>;
}

function CallCard({ payload }) {
  const labels = {
    calling: "Calling…",
    ringing: "Ringing…",
    active: "In call",
    completed: "Call ended",
    declined: "Declined",
    no_answer: "No answer",
    unavailable: "Unavailable",
    failed: "Could not connect",
  };
  const seconds = Math.round((payload.duration_ms ?? 0) / 1000);
  return <div className="call-history-card"><span aria-hidden="true">{payload.mode === "video" ? "▣" : "☎"}</span><span><strong>{payload.mode === "video" ? "Video" : "Audio"} call</strong><small>{labels[payload.status] ?? "Call"}{seconds ? ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : ""}</small></span></div>;
}
