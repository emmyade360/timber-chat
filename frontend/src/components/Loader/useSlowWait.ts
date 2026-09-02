import { useEffect, useState } from "react";

/**
 * Whether a wait has gone on long enough to deserve an explanation.
 *
 * A suspended relay takes tens of seconds to come back, and silence for that
 * long reads as a hang. Rather than lead with an apology for a wait that is
 * usually over in a moment, screens start with a plain caption and switch to a
 * fuller one only once this returns true.
 */
export function useSlowWait(active: boolean, afterMs = 6_000): boolean {
  const [slow, setSlow] = useState(false);
  const [previous, setPrevious] = useState(active);

  // Reset during render rather than from an effect. A second attempt should get
  // the short caption again instead of inheriting the last attempt's pessimism,
  // and doing that here avoids rendering the stale value once first.
  if (previous !== active) {
    setPrevious(active);
    setSlow(false);
  }

  useEffect(() => {
    if (!active) return undefined;
    const timer = setTimeout(() => { setSlow(true); }, afterMs);
    return () => { clearTimeout(timer); };
  }, [active, afterMs]);

  return slow;
}
