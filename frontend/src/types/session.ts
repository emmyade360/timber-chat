// Session, lock, and presentation state. None of it is conversation content.

/**
 * What the app is showing.
 *
 * `loading` is the splash while the vault is probed; it is not a resting state.
 * The other three are mutually exclusive and every transition between them is
 * explicit -- see the contract tests in src/app/sessionPhase.test.jsx.
 */
export type SessionPhase = "loading" | "onboarding" | "locked" | "ready";

/**
 * How long an unlocked session survives a reload. These are the stored string
 * values, not the key names in `LOCK_POLICIES` -- `always` is keyed `always`
 * but `two-hours` is keyed `twoHours`, so the two are not interchangeable.
 */
export type LockPolicyId = "always" | "two-hours" | "week" | "never";

/** Stored preference. `system` follows `prefers-color-scheme`. */
export type ThemePreference = "dark" | "light" | "system";

/** What the preference resolves to once the media query is read. */
export type ResolvedTheme = "dark" | "light";

export interface ThemeApplyOptions {
  target?: HTMLElement | null;
  storage?: Storage | null;
  systemDark?: boolean;
}
