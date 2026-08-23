// Invite link and referral progress. Invites help people begin a private
// conversation; they deliberately do not affect anyone's connection growth.

import { useEffect, useState } from "react";
import { getInvite, inviteUrl } from "../../lib/api.js";

export default function InvitePanel() {
  const [invite, setInvite] = useState(null);
  const [copied, setCopied] = useState("");

  useEffect(() => {
    getInvite()
      .then(({ data }) => setInvite(data))
      .catch(() => setInvite(null));
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
    setTimeout(() => setCopied(""), 2200);
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
        arrive. Invites never affect growth stages.
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
