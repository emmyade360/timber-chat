// The building blocks of a settings list.
//
// One row shape, used everywhere: a tinted icon, a label, an optional second
// line, and one trailing element that says what the row does -- a chevron to
// drill in, a switch to flip, or a value to read. Keeping that shape uniform is
// what lets someone scan the screen instead of reading it, which is the whole
// point of a settings list as opposed to a stack of panels.
//
// Rows are grouped into cards under a quiet heading, with the explanatory prose
// demoted to a footnote under the group rather than sitting between the
// controls.

/** A titled group of rows. `footnote` carries the explanation the rows cannot. */
export function SettingsGroup({ title, footnote, children }) {
  return (
    <section className="settings-group">
      {title && <h3 className="settings-group-title">{title}</h3>}
      <div className="settings-card">{children}</div>
      {footnote && <p className="settings-group-footnote">{footnote}</p>}
    </section>
  );
}

/**
 * One row.
 *
 * A row with `onClick` renders as a button; a row with `control` renders as a
 * plain div and hosts that control instead. Passing both would make the tap
 * target ambiguous, so it is not supported.
 *
 * The chevron is not decoration -- it promises another screen. `action` marks a
 * row that does the thing there and then (locking, clearing, opening a
 * confirmation) and drops it, so the affordance keeps meaning something.
 */
export function SettingsRow({
  icon,
  tint = "wood",
  title,
  subtitle,
  value,
  onClick,
  control,
  action = false,
  destructive = false,
  disabled = false,
}) {
  const interactive = Boolean(onClick);
  const Element = interactive ? "button" : "div";
  return (
    <Element
      className={`settings-item ${destructive ? "settings-item--danger" : ""} ${interactive ? "settings-item--tappable" : ""}`}
      {...(interactive ? { type: "button", onClick, disabled } : {})}
    >
      <span className={`settings-item-icon settings-item-icon--${tint}`} aria-hidden="true">{icon}</span>
      <span className="settings-item-text">
        <span className="settings-item-title">{title}</span>
        {subtitle && <span className="settings-item-subtitle">{subtitle}</span>}
      </span>
      {value !== undefined && <span className="settings-item-value">{value}</span>}
      {control}
      {interactive && !action && <Chevron />}
    </Element>
  );
}

/**
 * A switch for a boolean preference.
 *
 * It is a real checkbox underneath, so it is reachable by keyboard and
 * announced as a checkbox, with the track and knob drawn over it.
 */
export function SettingsSwitch({ checked, onChange, label, disabled = false }) {
  return (
    <label className={`switch ${disabled ? "switch--disabled" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch-track" aria-hidden="true"><span className="switch-knob" /></span>
    </label>
  );
}

function Chevron() {
  return (
    <svg className="settings-item-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}
