import { useEffect, useState } from "react";
import { applyTheme, readTheme } from "../lib/theme.js";

export function useTheme() {
  const [preference, setPreference] = useState(() => readTheme());

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    const paint = () => applyTheme(preference, { systemDark: query?.matches ?? true });
    paint();
    if (preference !== "system" || !query) return undefined;
    query.addEventListener("change", paint);
    return () => query.removeEventListener("change", paint);
  }, [preference]);

  return [preference, setPreference];
}
