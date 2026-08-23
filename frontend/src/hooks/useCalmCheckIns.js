// A browser app cannot reliably wake a closed device. This runs only while
// Timber is open, and only after the user explicitly enables generic check-ins.

import { useEffect } from "react";
import { maybeShowCheckIn } from "../lib/notifications.js";

export function useCalmCheckIns(enabled) {
  useEffect(() => {
    if (!enabled) return undefined;
    const show = () => { maybeShowCheckIn().catch(() => {}); };
    const initial = setTimeout(show, 2_000);
    const interval = setInterval(show, 60 * 60 * 1000);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [enabled]);
}
