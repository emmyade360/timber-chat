// The Vault is the quiet doorway to the people-facing parts of Timber. It
// keeps discovery out of the chat tab while preserving the app's direct,
// accepted-friend model.

import { useChatStore } from "../../store/chatStore.js";
import { Icons } from "../../components/Settings/icons.jsx";

export default function Vault({ onOpenPeople, onOpenExplore }) {
  const { pendingReceived, friends } = useChatStore();
  return (
    <div className="screen vault-screen">
      <header className="timber-header">
        <span className="timber-header-mark" aria-hidden="true">◈</span>
        <h1>Vault</h1>
        <span className="timber-header-lock" title="Private connections only">{Icons.lock}</span>
      </header>

      <section className="vault-intro">
        <p className="vault-eyebrow">PRIVATE CONNECTIONS</p>
        <h2>People you choose.</h2>
        <p>Find friends by username or opt into a small, mutual discovery deck. Nobody can message you without consent.</p>
      </section>

      <div className="vault-actions">
        <button className="vault-action" onClick={onOpenPeople}>
          <span className="vault-action-icon">{Icons.people}</span>
          <span><strong>People</strong><small>{friends.length} trusted {friends.length === 1 ? "connection" : "connections"}{pendingReceived.length ? ` · ${pendingReceived.length} waiting` : ""}</small></span>
          <span className="vault-chevron">›</span>
        </button>
        <button className="vault-action" onClick={onOpenExplore}>
          <span className="vault-action-icon">{Icons.explore}</span>
          <span><strong>Explore</strong><small>Private, mutual discovery</small></span>
          <span className="vault-chevron">›</span>
        </button>
      </div>

      <p className="vault-note">Your contacts, activity, and messages are never used as a public feed.</p>
    </div>
  );
}
