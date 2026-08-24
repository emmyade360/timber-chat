// Three states decide what the app shows: no vault on this device (onboard),
// a locked vault (unlock), or an unlocked session (the app itself).

import { useCallback, useEffect, useState } from "react";
import { vaultExists } from "./crypto/vault.js";
import { closeSession, isUnlocked } from "./crypto/session.js";
import { clearToken, getToken, logout, runtimeConfigurationError } from "./lib/api.js";
import { useAutoLock } from "./hooks/useAutoLock.js";
import { useCalmCheckIns } from "./hooks/useCalmCheckIns.js";
import { bootstrap, reconcileRealtime } from "./lib/sync.js";
import { useChatStore } from "./store/chatStore.js";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { useCall } from "./hooks/useCall.js";
import Onboarding from "./screens/Onboarding/Onboarding.jsx";
import Unlock from "./screens/Unlock/Unlock.jsx";
import Chats from "./screens/Chats/Chats.jsx";
import Chat from "./screens/Chat/Chat.jsx";
import People from "./screens/People/People.jsx";
import Explore from "./screens/Explore/Explore.jsx";
import Profile from "./screens/Profile/Profile.jsx";
import Settings from "./screens/Me/Me.jsx";
import LevelBadge from "./components/Level/LevelBadge.jsx";
import TogetherMark from "./components/Together/TogetherMark.jsx";
import InvitePanel from "./components/Invite/InvitePanel.jsx";
import CallOverlay from "./components/Call/CallOverlay.jsx";
import InstallTimberPrompt from "./components/Install/InstallTimberPrompt.jsx";
import { usePwaInstall } from "./hooks/usePwaInstall.js";
import "./index.css";

export default function App() {
  const [phase, setPhase] = useState("loading");
  const [notice, setNotice] = useState("");
  const [configurationError] = useState(() => runtimeConfigurationError());
  const [newAccountInstall, setNewAccountInstall] = useState(false);
  const pwa = usePwaInstall();

  useEffect(() => {
    vaultExists().then((exists) => {
      if (isUnlocked()) setPhase("ready");
      else setPhase(exists ? "locked" : "onboarding");
    });
  }, []);

  const enter = useCallback((options = {}) => {
    setNotice("");
    setNewAccountInstall(Boolean(options.newAccount));
    setPhase("ready");
  }, []);

  const revokeAndClearToken = useCallback(() => {
    if (getToken()) logout().catch(() => {});
    clearToken();
  }, []);

  const wiped = useCallback((message) => {
    closeSession();
    revokeAndClearToken();
    useChatStore.getState().reset();
    setNotice(message);
    setPhase("onboarding");
  }, [revokeAndClearToken]);

  const lock = useCallback(() => {
    closeSession();
    revokeAndClearToken();
    useChatStore.getState().reset();
    setPhase("locked");
  }, [revokeAndClearToken]);

  useAutoLock(phase === "ready", lock);

  if (configurationError) {
    return <main className="fatal-error" role="alert"><h1>Timber is unavailable</h1><p>{configurationError}</p></main>;
  }

  if (phase === "loading") {
    return (
      <div className="splash">
        <div className="wood-grain-overlay" />
        <TogetherMark variant="mark" />
        <p className="splash-text">Timber</p>
      </div>
    );
  }

  if (phase === "onboarding") {
    return (
      <>
        {notice && <div className="global-notice">{notice}</div>}
        <Onboarding onReady={enter} />
      </>
    );
  }

  if (phase === "locked") return <Unlock onUnlocked={enter} onWiped={wiped} />;

  return <Shell onSignOut={lock} onWiped={wiped} pwa={pwa} newAccountInstall={newAccountInstall} onInstallHandled={() => setNewAccountInstall(false)} />;
}

const TABS = [
  { id: "chats", label: "Chats", icon: "💬" },
  { id: "people", label: "People", icon: "👥" },
  { id: "explore", label: "Explore", icon: "🧭" },
  { id: "growth", label: "Growth", icon: null },
  { id: "profile", label: "Profile", icon: "👤" },
];

function Shell({ onSignOut, onWiped, pwa, newAccountInstall, onInstallHandled }) {
  const [tab, setTab] = useState("chats");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openConversation, setOpenConversation] = useState(null);
  const [manualInstall, setManualInstall] = useState(false);
  const { unread, pendingReceived, me, levelUp, dismissLevelUp } = useChatStore();
  const { send, connected, acknowledge, subscribe } = useWebSocket(true);
  const callController = useCall(send, subscribe);
  const { resumePendingCalls } = callController;
  useCalmCheckIns(true);

  useEffect(() => {
    bootstrap()
      .catch(() => {
        /* offline: the local store already painted what this device knows */
      })
      .finally(() => { resumePendingCalls().catch(() => {}); });
  }, [resumePendingCalls]);

  // Clearing the badge is a side effect of having the conversation on screen.
  useEffect(() => {
    if (openConversation) acknowledge(openConversation);
  }, [openConversation, acknowledge]);

  useEffect(() => {
    useChatStore.getState().setActiveConversation(openConversation);
  }, [openConversation]);

  const installMode = manualInstall ? "manual" : newAccountInstall ? "new-account" : null;

  const totalUnread = Object.values(unread).reduce((sum, count) => sum + count, 0);

  /** Open a chat with a friend, resolving the conversation if it is not cached. */
  const openWithFriend = async (friendId, conversationId) => {
    if (conversationId) {
      setOpenConversation(conversationId);
      setTab("chats");
      return;
    }
    const conversations = await reconcileRealtime();
    const match = conversations.find((entry) => entry.peer.id === friendId);
    if (match) {
      setOpenConversation(match.id);
      setTab("chats");
    }
  };

  if (openConversation) {
    return (
      <div className="app-shell">
        <div className="wood-grain-overlay" />
        {!connected && <div className="offline-bar">Reconnecting…</div>}
        <Chat
          conversationId={openConversation}
          send={send}
          onBack={() => setOpenConversation(null)}
          onStartCall={callController.startCall}
          call={callController.call}
        />
        <CallOverlay {...callController} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="wood-grain-overlay" />
      {!connected && <div className="offline-bar">Reconnecting…</div>}

      <main className="shell-main">
        {tab === "chats" && (
          <Chats
            onOpen={setOpenConversation}
            onFindPeople={() => setTab("people")}
            onInvite={() => setTab("growth")}
          />
        )}
        {tab === "people" && <People onOpenConversation={openWithFriend} />}
        {tab === "explore" && <Explore onOpenConversation={openWithFriend} />}
        {tab === "growth" && <Growth />}
        {tab === "profile" && !settingsOpen && <Profile onOpenSettings={() => setSettingsOpen(true)} />}
        {tab === "profile" && settingsOpen && (
          <Settings
            onBack={() => setSettingsOpen(false)}
            onOpenExplore={() => { setSettingsOpen(false); setTab("explore"); }}
            onOpenInstall={() => setManualInstall(true)}
            onSignOut={onSignOut}
            onWiped={onWiped}
          />
        )}
      </main>

      <nav className="tab-bar">
        {TABS.map((entry) => {
          const badge =
            entry.id === "chats" ? totalUnread : entry.id === "people" ? pendingReceived.length : 0;
          return (
            <button
              key={entry.id}
              className={`tab ${tab === entry.id ? "tab--active" : ""}`}
              onClick={() => { setSettingsOpen(false); setTab(entry.id); }}
            >
              <span className="tab-icon">
                {entry.icon ?? <LevelBadge level={me?.level ?? 1} size={22} />}
              </span>
              <span className="tab-label">{entry.label}</span>
              {badge > 0 && <span className="tab-badge">{badge > 9 ? "9+" : badge}</span>}
            </button>
          );
        })}
      </nav>

      {levelUp && (
        <div className="levelup-backdrop" onClick={dismissLevelUp}>
          <div className="levelup glass-panel" onClick={(event) => event.stopPropagation()}>
            <LevelBadge level={levelUp.level} size={128} />
            <h2 className="levelup-title">{levelUp.name}</h2>
            <p className="levelup-sub">You reached growth stage {levelUp.level}</p>
            <button className="btn-wood btn-block" onClick={dismissLevelUp}>
              Keep growing
            </button>
          </div>
        </div>
      )}
      <CallOverlay {...callController} />
      <InstallTimberPrompt open={Boolean(installMode)} manual={installMode === "manual"} pwa={pwa} onClose={() => { setManualInstall(false); onInstallHandled(); }} />
    </div>
  );
}

/** The complete connection-growth path, available as its own tab. */
function Growth() {
  const { me, ladder } = useChatStore();
  if (!ladder?.stages || !me) {
    return <div className="screen"><div className="empty-state">Loading…</div></div>;
  }

  return (
    <div className="screen">
      <header className="screen-header">
        <h1 className="screen-title">Growth</h1>
      </header>

      <section className="growth-hero">
        <LevelBadge level={me.level} size={88} />
        <p className="profile-level">{me.level_name}</p>
        <p className="growth-caption">
          {me.next_level_name
            ? `${me.growth_to_next.toLocaleString()} growth to ${me.next_level_name}`
            : "Your growth path is complete"}
        </p>
      </section>

      <InvitePanel />

      <ol className="ladder">
        {ladder.stages.map((tier) => {
          const reached = me.level >= tier.level;
          const current = me.level === tier.level;
          return (
            <li
              key={tier.level}
              className={`ladder-row ${reached ? "" : "ladder-row--locked"} ${current ? "ladder-row--current" : ""}`}
            >
              <LevelBadge level={tier.level} size={34} />
              <span className="ladder-name">{tier.name}</span>
              <span className="ladder-growth">{tier.threshold.toLocaleString()} growth</span>
              {current && <span className="ladder-you">you</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
