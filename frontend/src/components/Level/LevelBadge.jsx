// One component, twenty-one badges.
//
// Each growth stage is a cross-section of wood: the ring count grows with the stage, the
// palette walks from bark through heartwood and amber to crystal, and the top tiers
// gain facets and a sheen. Drawing it parametrically means a tier can be added or
// re-tuned by editing a table rather than commissioning twenty-one assets, and the
// same component scales from a 16px inline chip to a 128px profile hero.

const BANDS = [
  // upTo, core, ring, edge, glow
  //
  // Re-tuned for neutral dark surfaces. The walk is the same idea as before --
  // dim and cool at the start, warming through amber, cresting at crystal --
  // but the low tiers no longer disappear into a brown background, because the
  // background is no longer brown.
  { upTo: 2,  core: "#2B2D31", ring: "#4E5058", edge: "#6D7079", glow: "none" },
  { upTo: 4,  core: "#33363C", ring: "#5C6069", edge: "#7C8089", glow: "none" },
  { upTo: 6,  core: "#3A3D44", ring: "#6E727C", edge: "#949BA4", glow: "none" },
  { upTo: 8,  core: "#44403F", ring: "#8A7F72", edge: "#B0A292", glow: "none" },
  { upTo: 10, core: "#4E4436", ring: "#A08A64", edge: "#C7AE84", glow: "none" },
  { upTo: 12, core: "#5A4A2E", ring: "#C09A5C", edge: "#E2C48C", glow: "#C09A5C" },
  { upTo: 14, core: "#63421F", ring: "#D4894A", edge: "#F0B478", glow: "#D4894A" },
  { upTo: 16, core: "#6B3524", ring: "#DD7A4C", edge: "#F5A97B", glow: "#DD7A4C" },
  { upTo: 18, core: "#7A4A12", ring: "#E9A93A", edge: "#FBD98F", glow: "#E9A93A" },
  { upTo: 19, core: "#8A6410", ring: "#F5C242", edge: "#FFE9A8", glow: "#F5C242" },
  { upTo: 20, core: "#3F4A55", ring: "#9FB3C5", edge: "#DCE8F2", glow: "#9FB3C5" },
  { upTo: 21, core: "#1F4E5F", ring: "#7FD8E8", edge: "#EAFDFF", glow: "#7FD8E8" },
];

function paletteFor(level) {
  const clamped = Math.min(Math.max(level ?? 1, 1), 21);
  return BANDS.find((band) => clamped <= band.upTo) ?? BANDS[BANDS.length - 1];
}

export default function LevelBadge({ level = 1, size = 48, name = null, className = "" }) {
  const tier = Math.min(Math.max(level ?? 1, 1), 21);
  const palette = paletteFor(tier);
  const id = `badge-${tier}-${size}`;

  // Ring count tracks the growth stage but stops thickening past 10, so the badge
  // stays legible rather than turning into a solid disc.
  const rings = Math.min(tier, 10);
  const outer = 44;
  const innerMost = 9;
  const step = (outer - innerMost) / (rings + 1);

  // Real growth rings are not concentric; a small offset centre reads as wood
  // rather than as a target.
  const offsetX = 50 - Math.min(tier, 8) * 0.35;
  const offsetY = 50 + Math.min(tier, 8) * 0.2;

  const faceted = tier >= 20;
  const crystal = tier === 21;

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={`level-badge ${className}`}
      role="img"
      aria-label={name ? `${name} growth stage` : "Growth stage"}
    >
      <defs>
        <radialGradient id={`${id}-core`} cx="38%" cy="32%">
          <stop offset="0%" stopColor={palette.edge} stopOpacity="0.9" />
          <stop offset="55%" stopColor={palette.ring} stopOpacity="0.55" />
          <stop offset="100%" stopColor={palette.core} />
        </radialGradient>
        <linearGradient id={`${id}-bezel`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={palette.edge} />
          <stop offset="100%" stopColor={palette.core} />
        </linearGradient>
        {palette.glow !== "none" && (
          <filter id={`${id}-glow`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation={crystal ? 3.2 : 2} result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        )}
      </defs>

      <g filter={palette.glow !== "none" ? `url(#${id}-glow)` : undefined}>
        <circle cx="50" cy="50" r="47" fill={`url(#${id}-bezel)`} />
        <circle cx="50" cy="50" r="47" fill="none" stroke={palette.edge} strokeWidth="1.5" opacity="0.9" />
        <circle cx="50" cy="50" r="44" fill={`url(#${id}-core)`} />

        {Array.from({ length: rings }, (_, index) => {
          const radius = innerMost + step * (index + 1);
          return (
            <circle
              key={radius}
              cx={offsetX}
              cy={offsetY}
              r={radius}
              fill="none"
              stroke={palette.ring}
              strokeWidth={index % 2 === 0 ? 1.6 : 0.9}
              opacity={0.28 + (index / rings) * 0.5}
            />
          );
        })}

        <circle cx={offsetX} cy={offsetY} r={innerMost * 0.55} fill={palette.core} opacity="0.85" />
        <circle cx={offsetX} cy={offsetY} r={innerMost * 0.55} fill="none" stroke={palette.edge} strokeWidth="0.8" opacity="0.7" />

        {faceted &&
          [0, 60, 120, 180, 240, 300].map((angle) => (
            <line
              key={angle}
              x1="50"
              y1="50"
              x2={50 + 46 * Math.cos((angle * Math.PI) / 180)}
              y2={50 + 46 * Math.sin((angle * Math.PI) / 180)}
              stroke={palette.edge}
              strokeWidth="0.7"
              opacity="0.45"
            />
          ))}

        {crystal && (
          <polygon
            points="50,10 74,34 62,78 38,78 26,34"
            fill="none"
            stroke={palette.edge}
            strokeWidth="1.1"
            opacity="0.65"
          />
        )}

        {/* A single specular highlight keeps every tier from reading flat. */}
        <ellipse cx="36" cy="30" rx="16" ry="10" fill="#fff" opacity="0.13" transform="rotate(-28 36 30)" />
      </g>

    </svg>
  );
}

/** Compact inline badge + name, for chat headers and list rows. */
export function LevelChip({ level, name, size = 16 }) {
  return (
    <span className="level-chip" title={name ?? "Growth stage"}>
      <LevelBadge level={level} size={size} name={name} />
      <span className="level-chip-name">{name}</span>
    </span>
  );
}
