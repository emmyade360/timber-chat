// The waiting picture: a sapling that grows, sprouts, and finds people.
//
// Timber's mark already says "two separate lives, one shared grain". This says
// the same thing in motion, for the moments the app genuinely cannot go faster:
// claiming a username, or waking a relay that suspends when nobody is talking.
//
// Built the same way as the rest of the artwork -- parametric inline SVG, no
// library, nothing fetched, renders under `script-src 'self'` and offline in the
// installed PWA.
//
// Everything animates on `transform` and `opacity` only. That is not a style
// preference: those two are the properties a browser can animate off the main
// thread, so the picture keeps moving through the ~270ms the key derivation
// spends blocking on unlock. Animating a stroke dash, a width, or a filter would
// stall exactly when the user most needs to see that something is happening.

import styles from "./GrowingTree.module.css";

/**
 * The tree, as five branches off one trunk.
 *
 * `from` is where a branch leaves the trunk and `to` is where its person sits.
 *
 * These coordinates are deliberately mirrored in GrowingTree.module.css, which
 * needs them as transform origins and as the pulse offsets -- a stylesheet
 * cannot read them from here. GrowingTree.test.tsx asserts the two agree, so
 * moving a branch cannot silently leave a pulse travelling the wrong way.
 */
const BRANCHES = [
  { from: [60, 88], to: [30, 74] },
  { from: [60, 80], to: [92, 66] },
  { from: [60, 70], to: [34, 52] },
  { from: [60, 64], to: [88, 44] },
  // The crown. Straight up, and the last to arrive, so the eye finishes at the top.
  { from: [60, 58], to: [60, 34] },
] as const;

export interface GrowingTreeProps {
  /** Rendered size in px. Legible from about 48px up. */
  size?: number;
  /**
   * What is being waited for. Shown under the tree and announced politely, so
   * the wait is explained rather than merely decorated.
   */
  label?: string;
  className?: string;
}

export default function GrowingTree({ size = 120, label, className }: GrowingTreeProps) {
  return (
    <div
      className={className ? `${styles.root} ${className}` : styles.root}
      // `status` rather than `alert`: a wait is not an emergency, and polite
      // announcement will not interrupt whatever is already being read out.
      role="status"
      aria-live="polite"
    >
      <svg
        className={styles.scene}
        viewBox="0 0 120 120"
        width={size}
        height={size}
        // The picture carries no information the caption does not, so it is
        // decorative; the caption below is the accessible name.
        aria-hidden="true"
        focusable="false"
      >
        {/* Growth rings leaving the base, the way they do on the Timber mark. */}
        <g className={styles.rings}>
          <circle className={styles.ring} cx="60" cy="104" r="14" />
          <circle className={styles.ring} cx="60" cy="104" r="14" />
          <circle className={styles.ring} cx="60" cy="104" r="14" />
        </g>

        <line className={styles.ground} x1="30" y1="104" x2="90" y2="104" />

        {/* One group so the whole tree can sway from its base as a single piece. */}
        <g className={styles.tree}>
          <line className={styles.trunk} x1="60" y1="105" x2="60" y2="56" />

          {BRANCHES.map(({ from, to }) => (
            <line
              key={`branch-${String(to[0])}-${String(to[1])}`}
              className={styles.branch}
              x1={from[0]}
              y1={from[1]}
              x2={to[0]}
              y2={to[1]}
            />
          ))}

          {/* A person at every tip. Five warm hues, so they read as five
              different people rather than five copies of one. */}
          {BRANCHES.map(({ to }) => (
            <g key={`person-${String(to[0])}-${String(to[1])}`} className={styles.person}>
              <circle className={styles.halo} cx={to[0]} cy={to[1]} r="7.5" />
              <circle className={styles.head} cx={to[0]} cy={to[1] - 2.6} r="2.9" />
              <path
                className={styles.body}
                d={`M ${String(to[0] - 4.2)} ${String(to[1] + 5)}
                    a 4.2 4.2 0 0 1 8.4 0 Z`}
              />
            </g>
          ))}

          {/* What each person sends back down the branch to the trunk. */}
          {BRANCHES.map(({ to }) => (
            <circle
              key={`pulse-${String(to[0])}-${String(to[1])}`}
              className={styles.pulse}
              cx={to[0]}
              cy={to[1]}
              r="1.9"
            />
          ))}
        </g>
      </svg>

      {label ? <p className={styles.caption}>{label}</p> : <span className={styles.srOnly}>Loading</span>}
    </div>
  );
}
