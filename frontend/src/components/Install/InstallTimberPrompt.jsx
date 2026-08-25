// "Stay reachable": the one moment Timber asks to be able to reach someone.
//
// Two offers, because they answer the same question — will a call or a message
// find you when Timber is not open? Notifications are the part that actually
// matters and are shown first; installing makes them more reliable on phones
// but is not required for them to work.
//
// Either offer alone is reason enough to show this, so someone who installed
// months ago is still asked about notifications, and someone who cannot install
// is not shown a dead end.

import { useEffect, useState } from 'react';
import { getMeta, setMeta } from '../../db/localStore.js';
import { alertReadiness, alertsBlocked, alertsFullyEnabled, enableAllAlerts, pushStatusMessage } from '../../lib/alerts.js';
import { PUSH_STATUS } from '../../lib/push.js';

const INSTALL_KEY = 'pwa-install-prompt';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export default function InstallTimberPrompt({ open, manual = false, pwa, onClose }) {
  const [eligible, setEligible] = useState(false);
  const [alertsOn, setAlertsOn] = useState(true);
  const [pushStatus, setPushStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    if (!open) return undefined;
    (async () => {
      const [choice, enabled, readiness] = await Promise.all([
        getMeta(INSTALL_KEY).catch(() => null),
        alertsFullyEnabled().catch(() => false),
        alertReadiness().catch(() => ({ push: { status: PUSH_STATUS.unavailable } })),
      ]);
      if (!active) return;
      setAlertsOn(enabled);
      setPushStatus(readiness.push.status);
      // Nothing left to offer: alerts are on and the app is installed or cannot be.
      const nothingToOffer = enabled && (pwa.installed || (!pwa.canInstall && !pwa.isIos));
      const snoozed = !manual && (choice?.never || (choice?.remindAt ?? 0) > Date.now());
      const show = !nothingToOffer && !snoozed;
      setEligible(show);
      if (!show) onClose();
    })();
    return () => { active = false; };
  }, [manual, onClose, open, pwa.canInstall, pwa.installed, pwa.isIos]);

  if (!open || !eligible) return null;

  const close = () => onClose();
  const remind = async () => { await setMeta(INSTALL_KEY, { remindAt: Date.now() + WEEK_MS }).catch(() => {}); close(); };
  const never = async () => { await setMeta(INSTALL_KEY, { never: true }).catch(() => {}); close(); };

  const turnOnAlerts = async () => {
    setBusy(true);
    setNotice('');
    try {
      const { push } = await enableAllAlerts();
      setAlertsOn(true);
      const readiness = await alertReadiness().catch(() => null);
      if (readiness) setPushStatus(readiness.push.status);
      setNotice(push
        ? 'Calls and messages will reach this device even when Timber is closed.'
        : pushStatusMessage(readiness?.push.status));
    } catch (error) {
      const readiness = await alertReadiness().catch(() => null);
      if (readiness) setPushStatus(readiness.push.status);
      setNotice(readiness?.push.status
        ? pushStatusMessage(readiness.push.status)
        : (error.message || 'Notifications were not allowed by this browser.'));
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (pwa.canInstall) await pwa.promptInstall();
    else if (!pwa.isIos) await remind();
  };

  const showInstall = !pwa.installed && (pwa.canInstall || pwa.isIos);
  const pushUnavailable = [PUSH_STATUS.unsupported, PUSH_STATUS.missingKey, PUSH_STATUS.denied].includes(pushStatus);

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal glass-panel install-prompt" role="dialog" aria-modal="true" aria-labelledby="install-title">
        <h2 className="modal-title" id="install-title">Stay reachable</h2>

        {!alertsOn ? (
          <>
            <p className="panel-note">
              Let Timber tell you about calls and messages when the app is closed. It
              never includes what anyone said — only who it is from.
            </p>
            {alertsBlocked() ? (
              <p className="onboard-warning">
                Notifications are blocked for this site. Turn them back on in your
                browser’s site settings, then try again.
              </p>
            ) : pushUnavailable ? (
              <p className="onboard-warning">{pushStatusMessage(pushStatus)}</p>
            ) : (
              <button className="btn-wood btn-block" disabled={busy} onClick={turnOnAlerts}>
                {busy ? 'Asking…' : 'Turn on notifications'}
              </button>
            )}
          </>
        ) : (
          <p className="field-ok">Notifications are on for this device.</p>
        )}

        {showInstall && (
          <>
            <p className="panel-note">
              Installing Timber makes those alerts more reliable on a phone, and gives
              you a full-screen app instead of a browser tab.
            </p>
            {pwa.isIos && !pwa.canInstall && (
              <p className="onboard-warning">
                In Safari, tap Share, then choose <strong>Add to Home Screen</strong>.
              </p>
            )}
            {pwa.canInstall && (
              <button className="btn-ghost btn-block" onClick={install}>Install app</button>
            )}
          </>
        )}

        {notice && <p className="field-ok">{notice}</p>}

        {manual
          ? <button className="btn-ghost btn-block" onClick={close}>Done</button>
          : (
            <>
              <button className="btn-ghost btn-block" onClick={remind}>Remind me later</button>
              <button className="btn-ghost btn-block" onClick={never}>Never remind me</button>
            </>
          )}
      </section>
    </div>
  );
}
