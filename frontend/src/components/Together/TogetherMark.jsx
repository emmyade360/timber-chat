// Timber's signature mark: two cross-sections of wood that drift together until
// their growth rings meet and read as a single piece of grain.
//
// It is the one place the whole idea of the app is stated without words -- two
// separate lives, one shared grain -- so it is built to be watched for a few
// seconds rather than glanced at. Everything is CSS 3D and inline SVG: no
// library, nothing fetched, and it renders under the app's `script-src 'self'`
// policy and offline in the installed PWA.
//
// The depth is real rather than painted. Each log is a stack of discs pushed
// back along Z inside a `preserve-3d` scene, so when the pair tilts you see the
// side of the cylinder, and the highlight travels across the face the way it
// would on an actual turned edge.

const DEPTH_LAYERS = 7;

/** One cross-section face. `rings` grows the ring count so the two logs differ. */
function LogFace({ rings, seed }) {
  const innerMost = 8;
  const outer = 45;
  const step = (outer - innerMost) / (rings + 1);
  // Real rings are not concentric. Offsetting the heart a little reads as wood
  // instead of as a target, and offsetting the two logs differently keeps them
  // from looking like the same asset mirrored.
  const heartX = 50 + seed * 3.2;
  const heartY = 50 - seed * 2.1;

  return (
    <svg className="together-face" viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <radialGradient id={`together-core-${seed}`} cx="38%" cy="32%">
          <stop offset="0%" stopColor="#A9713F" stopOpacity="0.7" />
          <stop offset="55%" stopColor="#6E421F" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#4A2C18" />
        </radialGradient>
        <linearGradient id={`together-bezel-${seed}`} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0%" stopColor="#D4894A" />
          <stop offset="45%" stopColor="#8B5E3C" />
          <stop offset="100%" stopColor="#3E2415" />
        </linearGradient>
      </defs>

      <circle cx="50" cy="50" r="49" fill={`url(#together-bezel-${seed})`} />
      <circle cx="50" cy="50" r="45.5" fill={`url(#together-core-${seed})`} />

      {Array.from({ length: rings }, (_, index) => {
        const radius = innerMost + step * (index + 1);
        return (
          <circle
            key={radius}
            cx={heartX}
            cy={heartY}
            r={radius}
            fill="none"
            stroke={index % 2 === 0 ? "#E8C99A" : "#C49A6C"}
            strokeWidth={index % 2 === 0 ? 1.8 : 1}
            opacity={0.4 + (index / rings) * 0.42}
          />
        );
      })}

      <circle cx={heartX} cy={heartY} r="4.4" fill="#3E2415" opacity="0.9" />
      <circle cx={heartX} cy={heartY} r="4.4" fill="none" stroke="#D4894A" strokeWidth="0.7" opacity="0.75" />

      {/* One specular sweep keeps the face from reading flat under the tilt. */}
      <ellipse className="together-sheen" cx="35" cy="29" rx="19" ry="11" fill="#FFF3DF" opacity="0.09" />
    </svg>
  );
}

/** A turned log: a face, plus discs receding along Z that give it thickness. */
function Log({ side, rings, seed }) {
  return (
    <div className={`together-log together-log--${side}`}>
      <div className="together-billet">
        {Array.from({ length: DEPTH_LAYERS }, (_, index) => (
          <span
            key={index}
            className="together-slab"
            style={{ "--slab": index, "--slabs": DEPTH_LAYERS }}
          />
        ))}
        <LogFace rings={rings} seed={seed} />
      </div>
    </div>
  );
}

/**
 * @param {"hero"|"mark"} variant  `hero` carries the motto; `mark` is the bare
 *   animation, for places that already have their own heading.
 */
export default function TogetherMark({ variant = "hero", motto = "Two rings. One grain.", caption = "Every conversation adds a ring. Timber is where people grow together." }) {
  return (
    <div className={`together together--${variant}`}>
      <div className="wood-frame together-frame">
        <div
          className="together-stage"
          role="img"
          aria-label="Two cross-sections of wood drifting together until their growth rings meet"
        >
          <span className="together-ground" aria-hidden="true" />
          <div className="together-orbit">
            <Log side="a" rings={7} seed={1} />
            <Log side="b" rings={5} seed={-1} />
            {/* Emitted at the moment the two faces touch. */}
            <span className="together-seam" aria-hidden="true" />
            <span className="together-seam together-seam--late" aria-hidden="true" />
          </div>
        </div>
      </div>

      {variant === "hero" && (
        <div className="together-words">
          <p className="together-motto">{motto}</p>
          <p className="together-caption">{caption}</p>
        </div>
      )}
    </div>
  );
}
