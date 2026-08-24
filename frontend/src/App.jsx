// Three states decide what the app shows: no vault on this device (onboard),
// a locked vault (unlock), or an unlocked session (the app itself).

import { useCallback, useEffect, useState } from "react";
import { vaultExists } from "./crypto/vault.js";
import { closeSession, isUnlocked } from "./crypto/session.js";
import { clearToken, getToken, logout, runtimeConfigurationError } from "./lib/api.js";
import { useAutoLock } from "./hooks/useAutoLock.js";
import { useIsDesktop } from "./hooks/useIsDesktop.js";
import { useCalmCheckIns } from "./hooks/useCalmCheckIns.js";
import { bootstrap, reconcileRealtime } from "./lib/sync.js";
import { consumePendingTarget, subscribePendingTarget } from "./lib/deepLink.js";
import { ensurePushSubscription } from "./lib/push.js";
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
import { Icons } from "./components/Settings/icons.jsx";
import TogetherMark from "./components/Together/TogetherMark.jsx";
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

  // Never lock mid-call: the 30s hidden timer would otherwise fire the moment
  // someone backgrounds the app to answer, wiping the keys the call needs.
  const callActive = useChatStore((state) => state.callActive);
  useAutoLock(phase === "ready" && !callActive, lock);

  if (configurationError) {
    return <main className="fatal-error" role="alert"><h1>Timber is unavailable</h1><p>{configurationError}</p></main>;
  }

  if (phase === "loading") {
    return (
      <div className="splash">
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

// Four, not five: Growth moved inside Profile. It is a reference screen people
// visit occasionally, and it was taking a permanent slot in a bar that has to
// stay readable at 360px.
const TABS = [
  { id: "chats", label: "Chats", icon: Icons.chats },
  { id: "people", label: "People", icon: Icons.people },
  { id: "explore", label: "Explore", icon: Icons.explore },
  { id: "profile", label: "Profile", icon: Icons.profile },
];

function Shell({ onSignOut, onWiped, pwa, newAccountInstall, onInstallHandled }) {
  const [tab, setTab] = useState("chats");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openConversation, setOpenConversation] = useState(null);
  const [manualInstall, setManualInstall] = useState(false);
  const isDesktop = useIsDesktop();
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
      .finally(() => {
        resumePendingCalls().catch(() => {});
        // Re-register the push endpoint if the browser rotated it while we were
        // closed; otherwise this device silently stops getting alerts forever.
        ensurePushSubscription().catch(() => {});
      });
  }, [resumePendingCalls]);

  // Act on a tapped notification. This is the first moment it can be done: the
  // target is latched at page load, but the shell does not exist until the
  // vault is unlocked, which a cold start from a notification always goes
  // through. Both paths land here -- the URL on a cold start, a postMessage
  // from the service worker when a tab was already open.
  useEffect(() => {
    const open = async (target) => {
      if (!target) return;
      if (target.kind === "people") { setTab("people"); return; }
      if (!target.conversationId) return;
      // A call answers itself through resumePendingCalls; showing the thread it
      // belongs to is the useful thing to do either way.
      setTab("chats");
      const known = useChatStore.getState().conversations
        .some((entry) => entry.id === target.conversationId);
      if (!known) await reconcileRealtime().catch(() => {});
      setOpenConversation(target.conversationId);
      if (target.kind === "call") resumePendingCalls().catch(() => {});
    };

    open(consumePendingTarget());
    return subscribePendingTarget((target) => { open(target).catch(() => {}); });
  }, [resumePendingCalls]);

  // Acknowledging lives in Chat, chained after its history load: doing it here
  // read the local store before the backfill had written to it, so anything
  // that arrived while away was left unacknowledged until the next open.

  useEffect(() => {
    useChatStore.getState().setActiveConversation(openConversation);
  }, [openConversation]);

  const installMode = manualInstall ? "manual" : newAccountInstall ? "new-account" : null;
  const closeInstall = () => { setManualInstall(false); onInstallHandled(); };

  const levelUpModal = levelUp ? (
    <div className="levelup-backdrop" onClick={dismissLevelUp}>
      <div className="levelup glass-panel" onClick={(event) => event.stopPropagation()}>
        <LevelBadge level={levelUp.level} size={128} name={levelUp.name} />
        <h2 className="levelup-title">{levelUp.name}</h2>
        <p className="levelup-sub">A new growth stage</p>
        <button className="btn-wood btn-block" onClick={dismissLevelUp}>Keep growing</button>
      </div>
    </div>
  ) : null;

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

  const listPane = (
    <>
      {tab === "chats" && (
        <Chats
          onOpen={setOpenConversation}
          activeConversationId={isDesktop ? openConversation : null}
          onFindPeople={() => setTab("people")}
          onInvite={() => { setTab("profile"); setSettingsOpen(true); }}
        />
      )}
      {tab === "people" && <People onOpenConversation={openWithFriend} />}
      {tab === "explore" && <Explore onOpenConversation={openWithFriend} />}
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
    </>
  );

  const conversation = openConversation ? (
    <Chat
      key={openConversation}
      conversationId={openConversation}
      send={send}
      onAcknowledge={acknowledge}
      onBack={isDesktop ? null : () => setOpenConversation(null)}
      onStartCall={callController.startCall}
      call={callController.call}
    />
  ) : null;

  const nav = (
    <nav className="tab-bar" aria-label="Sections">
      {TABS.map((entry) => {
        const badge =
          entry.id === "chats" ? totalUnread : entry.id === "people" ? pendingReceived.length : 0;
        return (
          <button
            key={entry.id}
            className={`tab ${tab === entry.id ? "tab--active" : ""}`}
            aria-current={tab === entry.id ? "page" : undefined}
            title={entry.label}
            onClick={() => { setSettingsOpen(false); setTab(entry.id); }}
          >
            <span className="tab-icon">{entry.icon}</span>
            <span className="tab-label">{entry.label}</span>
            {badge > 0 && <span className="tab-badge">{badge > 9 ? "9+" : badge}</span>}
          </button>
        );
      })}
    </nav>
  );

  // Phone: one thing at a time, and a conversation takes the whole screen.
  if (!isDesktop) {
    if (openConversation) {
      return (
        <div className="app-shell">
          {!connected && <div className="offline-bar">Reconnecting…</div>}
          {conversation}
          <CallOverlay {...callController} />
        </div>
      );
    }
    return (
      <div className="app-shell">
        {!connected && <div className="offline-bar">Reconnecting…</div>}
        <main className="shell-main">{listPane}</main>
        {nav}
        {levelUpModal}
        <CallOverlay {...callController} />
        <InstallTimberPrompt open={Boolean(installMode)} manual={manualInstall} pwa={pwa} onClose={closeInstall} />
      </div>
    );
  }

  // Desktop: rail, list, conversation. The list stays mounted beside the thread
  // so opening a message no longer hides navigation or throws away the scroll
  // position of the list you came from.
  return (
    <div className="app-shell app-shell--desktop">
      {!connected && <div className="offline-bar">Reconnecting…</div>}
      {nav}
      <main className="shell-main">
        <div className="pane pane--list">{listPane}</div>
        <div className="pane pane--detail">
          {conversation ?? (
            <div className="pane-empty">
              <LevelBadge level={me?.level ?? 1} size={64} />
              <p className="pane-empty-title">Timber</p>
              <p className="pane-empty-sub">Choose a conversation to start reading.</p>
            </div>
          )}
        </div>
      </main>

      {levelUpModal}
      <CallOverlay {...callController} />
      <InstallTimberPrompt open={Boolean(installMode)} manual={manualInstall} pwa={pwa} onClose={closeInstall} />
    </div>
  );
}

