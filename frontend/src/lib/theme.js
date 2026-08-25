// A theme is presentation-only device state. It deliberately lives outside the
// encrypted vault: it contains no account or conversation information and lets
// the landing screen honour the last choice before a vault is unlocked.

export const THEME_STORAGE_KEY = "timber-theme";
export const THEME_PREFERENCES = ["dark", "light", "system"];

export function normalizeTheme(value) {
  return THEME_PREFERENCES.includes(value) ? value : "dark";
}

export function readTheme(storage = globalThis?.localStorage) {
  try { return normalizeTheme(storage?.getItem(THEME_STORAGE_KEY)); }
  catch { return "dark"; }
}

export function resolvedTheme(preference, systemDark = true) {
  const value = normalizeTheme(preference);
  return value === "system" ? (systemDark ? "dark" : "light") : value;
}

export function applyTheme(preference, {
  target = globalThis?.document?.documentElement,
  storage = globalThis?.localStorage,
  systemDark = globalThis?.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? true,
} = {}) {
  const value = normalizeTheme(preference);
  const theme = resolvedTheme(value, systemDark);
  if (target) {
    target.dataset.theme = theme;
    target.style.colorScheme = theme;
  }
  try { storage?.setItem(THEME_STORAGE_KEY, value); } catch { /* optional preference */ }
  return theme;
}
