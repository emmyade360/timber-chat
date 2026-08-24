// One component, twenty-one badges.
//
// Each growth stage is a cross-section of wood: the ring count grows with the stage, the
// palette walks from bark through heartwood and amber to crystal, and the top tiers
// gain facets and a sheen. Drawing it parametrically means a tier can be added or
// re-tuned by editing a table rather than commissioning twenty-one assets, and the
// same component scales from a 16px inline chip to a 128px profile hero.

const BANDS = [
  // upTo, core, ring, edge, glow
  { upTo: 2,  core: "#3E2415", ring: "#5C3317", edge: "#7A4A24", glow: "none" },
  { upTo: 4,  core: "#4A2C18", ring: "#6E421F", edge: "#8B5E3C", glow: "none" },
  { upTo: 6,  core: "#5C3317", ring: "#8B5E3C", edge: "#A9713F", glow: "none" },
  { upTo: 8,  core: "#6E421F", ring: "#A9713F", edge: "#C49A6C", glow: "none" },
  { upTo: 10, core: "#7A4A24", ring: "#C49A6C", edge: "#D4894A", glow: "none" },
  { upTo: 12, core: "#8B5E3C", ring: "#D4894A", edge: "#E8C99A", glow: "#D4894A" },
  { upTo: 14, core: "#7C2D1A", ring: "#C25A2E", edge: "#E8A05A", glow: "#C25A2E" },
  { upTo: 16, core: "#6B1F2E", ring: "#B0413F", edge: "#E0855F", glow: "#B0413F" },
  { upTo: 18, core: "#8A4B12", ring: "#D99A2B", edge: "#F5D98A", glow: "#D99A2B" },
  { upTo: 19, core: "#9A6410", ring: "#F0B23C", edge: "#FFE9A8", glow: "#F0B23C" },
  { upTo: 20, core: "#3F4A55", ring: "#8FA3B5", edge: "#D3E1EC", glow: "#8FA3B5" },
  { upTo: 21, core: "#1F4E5F", ring: "#7FD8E8", edge: "#EAFDFF", glow: "#7FD8E8" },
];

function paletteFor(level) {
  const clamped = Math.min(Math.max(level ?? 1, 1), 21);
  return BANDS.find((band) => clamped <= band.upTo) ?? BANDS[BANDS.length - 1];
}

export default function LevelBadge({ level = 1, size = 48, showNumber = false, className = "" }) {
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
      aria-label={`Growth stage ${tier}`}
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

      {showNumber && (
        <text
          x="50"
          y="50"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="30"
          fontWeight="700"
          fill={palette.edge}
          paintOrder="stroke"
          stroke={palette.core}
          strokeWidth="4"
        >
          {tier}
        </text>
      )}
    </svg>
  );
}

/** Compact inline badge + name, for chat headers and list rows. */
export function LevelChip({ level, name, size = 16 }) {
  return (
    <span className="level-chip" title={`Growth stage ${level} — ${name ?? ""}`}>
      <LevelBadge level={level} size={size} />
      <span className="level-chip-name">{name}</span>
    </span>
  );
}
