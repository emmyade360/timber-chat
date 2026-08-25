import { useCallback, useState } from "react";
import { readLockPolicy } from "../lib/lockPolicy.js";
import { applyLockPolicy } from "../lib/lockSession.js";

/** Keep the auto-lock choice live in the shell and persisted across launches. */
export function useLockPolicy() {
  const [policy, setPolicy] = useState(() => readLockPolicy());
  const updatePolicy = useCallback((next) => {
    // Painted immediately; the resume token behind it is re-sealed or dropped
    // in the background, so the setting cannot show one thing and mean another.
    setPolicy(next);
    applyLockPolicy(next).then(setPolicy).catch(() => {});
    return next;
  }, []);
  return [policy, updatePolicy];
}
