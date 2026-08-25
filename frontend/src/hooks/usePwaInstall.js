import { useCallback, useEffect, useRef, useState } from 'react';

function standalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

export function usePwaInstall() {
  const deferred = useRef(null);
  const [canInstall, setCanInstall] = useState(false);
  const [installed, setInstalled] = useState(() => typeof window !== 'undefined' && standalone());
  const [justInstalled, setJustInstalled] = useState(false);

  useEffect(() => {
    const capture = (event) => {
      event.preventDefault();
      deferred.current = event;
      setCanInstall(true);
    };
    const complete = () => {
      deferred.current = null;
      setCanInstall(false);
      setInstalled(true);
      setJustInstalled(true);
    };
    window.addEventListener('beforeinstallprompt', capture);
    window.addEventListener('appinstalled', complete);
    return () => {
      window.removeEventListener('beforeinstallprompt', capture);
      window.removeEventListener('appinstalled', complete);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    const prompt = deferred.current;
    if (!prompt) return false;
    await prompt.prompt();
    const result = await prompt.userChoice;
    if (result.outcome === 'accepted') { deferred.current = null; setCanInstall(false); }
    return result.outcome === 'accepted';
  }, []);

  const acknowledgeInstalled = useCallback(() => setJustInstalled(false), []);

  const isIos = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  return { canInstall, installed, isIos, promptInstall, justInstalled, acknowledgeInstalled };
}
