// Invite link and referral progress. An invite starts a private conversation and,
// since the engagement rebalance, earns the inviter growth -- capped per day, and
// credited exactly once per invited account.

import { useEffect, useRef, useState } from "react";
import { getInvite, inviteUrl } from "../../lib/api.js";

export default function InvitePanel() {
  const [invite, setInvite] = useState(null);
  const [copied, setCopied] = useState("");
  const clearCopied = useRef(null);

  // The "copied" toast clears itself on a timer started in an event handler, so
  // the timer has to be cancelled if the panel closes first.
  useEffect(() => () => { if (clearCopied.current) clearTimeout(clearCopied.current); }, []);

  useEffect(() => {
    // Ignore a response that arrives after this panel has gone away. Without
    // the flag a slow reply lands on an unmounted component, and under
    // StrictMode's double mount the first request's result can overwrite the
    // second's.
    let ignore = false;
    getInvite()
      .then(({ data }) => { if (!ignore) setInvite(data); })
      .catch(() => { if (!ignore) setInvite(null); });
    return () => { ignore = true; };
  }, []);

  if (!invite) return null;

  const url = inviteUrl(invite.code);

  const copy = async (value, label) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard access can be refused; the link stays selectable on screen.
      setCopied("Select the link above to copy it.");
      return;
    }
    setCopied(`${label} copied`);
    if (clearCopied.current) clearTimeout(clearCopied.current);
    clearCopied.current = setTimeout(() => { setCopied(""); }, 2200);
  };

  const share = async () => {
    // The native sheet is the best path on mobile; fall back to the clipboard.
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Timber",
          text: "Join me on Timber — private, end-to-end encrypted chat.",
          url,
        });
        return;
      } catch {
        /* dismissed by the user; fall through to copying */
      }
    }
    copy(url, "Invite link");
  };

  return (
    <section className="panel invite-panel">
      <h3 className="section-title">Invite friends</h3>
      <p className="panel-note">
        Invite someone you trust to begin an end-to-end encrypted conversation. You
        are added as friends automatically, so there is someone to talk to when they
        arrive — and you earn growth when they join.
      </p>

      <div className="invite-stats">
        <div className="stat">
          <span className="stat-value">{invite.joined}</span>
          <span className="stat-label">Joined</span>
        </div>
      </div>

      <label className="field-label" htmlFor="invite-link">Your invite link</label>
      <div className="invite-link-row">
        <input
          id="invite-link"
          className="glass-input invite-link"
          readOnly
          value={url}
          onFocus={(event) => event.target.select()}
        />
        <button className="btn-wood btn-sm" onClick={() => copy(url, "Link")}>
          Copy
        </button>
      </div>

      <div className="invite-code-row">
        <span className="invite-code-label">or share your code</span>
        <button className="invite-code" onClick={() => copy(invite.code, "Code")}>
          {invite.code}
        </button>
      </div>

      <button className="btn-wood btn-block" onClick={share}>
        Share invite
      </button>
      <span className="invite-copied" role="status">{copied}</span>
    </section>
  );
}
