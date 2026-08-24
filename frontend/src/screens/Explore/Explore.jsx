// Mutual, adult-only friend discovery. Explore is intentionally separate from
// E2EE chat: these cards are public to the small eligible deck, never a feed.

import { useEffect, useState } from "react";
import {
  blockExploreCard,
  getExploreCards,
  getExploreMatches,
  getExploreProfile,
  likeExploreCard,
  passExploreCard,
  reportExploreCard,
  updateExploreProfile,
  userMessage,
} from "../../lib/api.js";
import { reconcileRealtime } from "../../lib/sync.js";
import Modal from "../../components/Modal.jsx";

const EMPTY_PROFILE = {
  adult_confirmed: false,
  is_visible: false,
  photo_url: "",
  bio: "",
  interests: [],
  metro_area: "",
};

export default function Explore({ onOpenConversation }) {
  const [profile, setProfile] = useState(EMPTY_PROFILE);
  const [allowedInterests, setAllowedInterests] = useState([]);
  const [cards, setCards] = useState([]);
  const [matches, setMatches] = useState([]);
  const [metroConfigured, setMetroConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [reporting, setReporting] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [profileResponse, matchesResponse] = await Promise.all([getExploreProfile(), getExploreMatches()]);
      const saved = profileResponse.data.profile;
      setAllowedInterests(profileResponse.data.allowed_interests ?? []);
      setMetroConfigured(Boolean(profileResponse.data.metro_configured));
      setProfile(saved ? {
        adult_confirmed: true,
        is_visible: saved.is_visible,
        photo_url: saved.photo_url ?? "",
        bio: saved.bio ?? "",
        interests: saved.interests ?? [],
        // The server intentionally never returns this. A user chooses it again
        // only when changing their card, which prevents accidental public use.
        metro_area: "",
      } : EMPTY_PROFILE);
      setMatches(matchesResponse.data.matches ?? []);
      if (saved?.is_visible) {
        const deck = await getExploreCards();
        setCards(deck.data.cards ?? []);
      } else {
        setCards([]);
      }
    } catch (error) {
      setNotice(userMessage(error, "Explore is unavailable right now."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => { load(); }, 0);
    return () => clearTimeout(timer);
  }, []);

  const save = async (visible = profile.is_visible) => {
    setBusy(true);
    setNotice("");
    if (!profile.metro_area.trim() && !metroConfigured) {
      setNotice("Choose a metro matching area. It is never shown to other people.");
      setBusy(false);
      return;
    }
    try {
      const response = await updateExploreProfile({ ...profile, is_visible: visible });
      const saved = response.data.profile;
      setProfile((current) => ({
        ...current,
        adult_confirmed: true,
        is_visible: saved.is_visible,
        photo_url: saved.photo_url ?? "",
        bio: saved.bio ?? "",
        interests: saved.interests ?? [],
        metro_area: "",
      }));
      setMetroConfigured(true);
      if (saved.is_visible) {
        const deck = await getExploreCards();
        setCards(deck.data.cards ?? []);
        setNotice("Your card is visible to a small, matching deck. Your metro is never shown.");
      } else {
        setCards([]);
        setNotice("Explore is off. Your outstanding likes were cleared; existing friends and chats remain.");
      }
    } catch (error) {
      setNotice(userMessage(error, "Could not update Explore. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const toggleInterest = (interest) => {
    setProfile((current) => {
      const selected = current.interests.includes(interest)
        ? current.interests.filter((value) => value !== interest)
        : current.interests.length < 5 ? [...current.interests, interest] : current.interests;
      return { ...current, interests: selected };
    });
  };

  const act = async (card, action) => {
    setBusy(true);
    setNotice("");
    try {
      const result = await action(card.id);
      setCards((current) => current.filter((entry) => entry.id !== card.id));
      if (result.data?.matched) {
        await reconcileRealtime();
        const freshMatches = await getExploreMatches();
        setMatches(freshMatches.data.matches ?? []);
        setNotice(`It’s a mutual connection with @${card.username}. Your private chat is ready.`);
      }
    } catch (error) {
      setNotice(userMessage(error, "Could not update your Explore deck. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const report = async (card, reason) => {
    setBusy(true);
    try {
      await reportExploreCard(card.id, { reason });
      setCards((current) => current.filter((entry) => entry.id !== card.id));
      setNotice("Thanks. The card is hidden from you and the report is queued for human review.");
    } catch (error) {
      setNotice(userMessage(error, "Could not send that report. Please try again."));
    } finally {
      setBusy(false);
      setReporting(null);
    }
  };

  if (loading) return <div className="screen"><div className="empty-state">Loading Explore…</div></div>;

  return (
    <div className="screen explore-screen">
      <header className="screen-header">
        <h1 className="screen-title">Explore</h1>
      </header>

      <section className="panel explore-intro">
        <h2 className="section-title">Private, mutual discovery</h2>
        <p className="panel-note">
          Explore is for adults looking for friendship. There are no public posts, open DMs,
          maps, distances, online indicators, or city labels. A card is public Explore data,
          not encrypted chat content; private chats begin only after a mutual like.
        </p>
      </section>

      <section className="panel explore-profile">
        <h2 className="section-title">Your Explore card</h2>
        <label className="explore-check">
          <input
            type="checkbox"
            checked={profile.adult_confirmed}
            onChange={(event) => setProfile((current) => ({ ...current, adult_confirmed: event.target.checked }))}
          />
          <span>I confirm that I am 18 or older.</span>
        </label>
        <div className="field-group">
          <label className="field-label" htmlFor="explore-photo">Public photo URL</label>
          <input id="explore-photo" className="glass-input" type="url" placeholder="https://…" value={profile.photo_url}
            onChange={(event) => setProfile((current) => ({ ...current, photo_url: event.target.value }))} />
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor="explore-bio">Bio ({profile.bio.length}/160)</label>
          <textarea id="explore-bio" className="glass-input explore-bio" maxLength="160" value={profile.bio}
            placeholder="A little about the kinds of friendships you enjoy…"
            onChange={(event) => setProfile((current) => ({ ...current, bio: event.target.value }))} />
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor="explore-metro">Metro matching area — never displayed</label>
          <input id="explore-metro" className="glass-input" value={profile.metro_area}
            placeholder="e.g. Lagos" maxLength="64"
            onChange={(event) => setProfile((current) => ({ ...current, metro_area: event.target.value }))} />
          <p className="field-help">No browser location is requested. This is only a hidden matching filter.</p>
        </div>
        <fieldset className="interest-set">
          <legend className="field-label">Interests (choose 1–5)</legend>
          <div className="interest-chips">
            {allowedInterests.map((interest) => (
              <button type="button" key={interest}
                className={`interest-chip ${profile.interests.includes(interest) ? "interest-chip--selected" : ""}`}
                aria-pressed={profile.interests.includes(interest)} onClick={() => toggleInterest(interest)}>
                {interest}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="row-actions">
          <button className="btn-wood" disabled={busy || !profile.adult_confirmed} onClick={() => save(true)}>
            {profile.is_visible ? "Update card" : "Enable Explore"}
          </button>
          {profile.is_visible && (
            <button className="btn-ghost" disabled={busy} onClick={() => save(false)}>Turn off</button>
          )}
        </div>
      </section>

      {notice && <p className="people-notice field-ok">{notice}</p>}

      {profile.is_visible && (
        <section className="explore-deck" aria-live="polite">
          <h2 className="section-title">A small matching deck</h2>
          {cards.length === 0 ? (
            <p className="section-empty">No new cards right now. Explore stays intentionally small.</p>
          ) : cards.map((card) => (
            <article className="explore-card glass-panel" key={card.id}>
              <div className="explore-card-top">
                {card.photo_url ? <img className="explore-photo" src={card.photo_url} alt="" referrerPolicy="no-referrer" /> : <span className="avatar">{card.username[0]?.toUpperCase()}</span>}
                <div><h3>@{card.username}</h3><p>{card.bio}</p></div>
              </div>
              <div className="interest-chips">{card.interests.map((interest) => <span key={interest} className="interest-chip interest-chip--static">{interest}</span>)}</div>
              <div className="explore-actions">
                <button className="btn-ghost btn-sm" disabled={busy} onClick={() => act(card, passExploreCard)}>Pass</button>
                <button className="btn-wood btn-sm" disabled={busy} onClick={() => act(card, likeExploreCard)}>Like</button>
                <button className="explore-link" disabled={busy} onClick={() => setReporting(card)}>Safety options</button>
              </div>
            </article>
          ))}
        </section>
      )}

      {matches.length > 0 && (
        <section className="people-section">
          <h2 className="section-title">Mutual connections</h2>
          {matches.map((match) => (
            <div className="people-row" key={match.id}>
              <span className="avatar avatar--sm">{match.username[0]?.toUpperCase()}</span>
              <span className="people-row-text"><span className="people-row-name">@{match.username}</span><span className="row-note">Matched through Explore</span></span>
              {match.conversation_id && <button className="btn-wood btn-sm" onClick={() => onOpenConversation(match.user_id, match.conversation_id)}>Message</button>}
            </div>
          ))}
        </section>
      )}

      {reporting && (
        <Modal title="Safety options" onClose={() => setReporting(null)}>
            <p className="panel-note">Blocking removes both cards from future Explore decks. Reporting also hides this card and sends it to a human review queue.</p>
            <button className="btn-danger btn-block" disabled={busy} onClick={async () => {
              await act(reporting, blockExploreCard);
              setReporting(null);
            }}>Block @{reporting.username}</button>
            <div className="report-options">
              <button className="btn-ghost btn-block" disabled={busy} onClick={() => report(reporting, "harassment")}>Report harassment</button>
              <button className="btn-ghost btn-block" disabled={busy} onClick={() => report(reporting, "impersonation")}>Report impersonation</button>
              <button className="btn-ghost btn-block" disabled={busy} onClick={() => report(reporting, "unsafe")}>Report unsafe behavior</button>
            </div>
            <button className="btn-ghost btn-block" onClick={() => setReporting(null)}>Cancel</button>
        </Modal>
      )}
    </div>
  );
}
