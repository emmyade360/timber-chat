import { useCallback, useState } from "react";
import { readLockPolicy, writeLockPolicy } from "../lib/lockPolicy.js";

/** Keep the auto-lock choice live in the shell and persisted across launches. */
export function useLockPolicy() {
  const [policy, setPolicy] = useState(() => readLockPolicy());
  const updatePolicy = useCallback((next) => {
    const saved = writeLockPolicy(next);
    setPolicy(saved);
    return saved;
  }, []);
  return [policy, updatePolicy];
}
