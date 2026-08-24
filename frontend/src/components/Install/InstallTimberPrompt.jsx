import { useEffect, useState } from 'react';
import { getMeta, setMeta } from '../../db/localStore.js';

const INSTALL_KEY = 'pwa-install-prompt';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export default function InstallTimberPrompt({ open, manual = false, pwa, onClose }) {
  const [eligible, setEligible] = useState(false);

  useEffect(() => {
    let active = true;
    if (!open || pwa.installed) return undefined;
    (async () => {
      const choice = await getMeta(INSTALL_KEY);
      if (!active) return;
      const hidden = !manual && (choice?.never || (choice?.remindAt ?? 0) > Date.now());
      setEligible(!hidden);
      if (hidden) onClose();
    })().catch(() => { if (active) setEligible(true); });
    return () => { active = false; };
  }, [manual, onClose, open, pwa.installed]);

  if (!open || pwa.installed || !eligible) return null;
  const close = () => onClose();
  const remind = async () => { await setMeta(INSTALL_KEY, { remindAt: Date.now() + WEEK_MS }); close(); };
  const never = async () => { await setMeta(INSTALL_KEY, { never: true }); close(); };
  const install = async () => {
    if (pwa.canInstall) await pwa.promptInstall();
    else if (!pwa.isIos) await remind();
  };

  return <div className="modal-backdrop" role="presentation"><section className="modal glass-panel install-prompt" role="dialog" aria-modal="true" aria-labelledby="install-title">
    <h2 className="modal-title" id="install-title">Install Timber</h2>
    <p className="panel-note">Add Timber to your home screen for a calmer, full-screen private chat experience and optional incoming-call alerts.</p>
    {pwa.isIos && !pwa.canInstall && <p className="onboard-warning">In Safari, tap Share, then choose <strong>Add to Home Screen</strong>.</p>}
    {pwa.canInstall && <button className="btn-wood btn-block" onClick={install}>Install app</button>}
    {!pwa.canInstall && !pwa.isIos && <p className="panel-note">Your browser does not offer installation yet. You can keep using Timber securely in this tab.</p>}
    <button className="btn-ghost btn-block" onClick={remind}>Remind me later</button>
    <button className="btn-ghost btn-block" onClick={never}>Never remind me</button>
    {manual && <button className="btn-ghost btn-block" onClick={close}>Done</button>}
  </section></div>;
}
