// One component, twenty-one diamonds.
//
// A brilliant cut seen face-on: the flat table in the middle, a ring of crown
// facets around it, and the girdle at the rim. Stages advance in two ways that
// read at a glance -- the stone gains facets as it is cut, and the palette walks
// from dull graphite through white fire into the warm and coloured rarities.
//
// Drawn parametrically rather than as twenty-one assets, so rebalancing the
// ladder is a table edit and the same component works from a 14px chip beside a
// username to a 128px celebration.

const BANDS = [
  // upTo, deep, mid, bright, fire (the sparkle that only cut stones get)
  { upTo: 2,  deep: "#232428", mid: "#3A3D44", bright: "#5A5E66", fire: "none" },
  { upTo: 4,  deep: "#2A2C31", mid: "#474B54", bright: "#6E737D", fire: "none" },
  { upTo: 6,  deep: "#31343A", mid: "#565B66", bright: "#868C97", fire: "none" },
  { upTo: 8,  deep: "#383C44", mid: "#666C79", bright: "#9AA2AF", fire: "#B9C2CF" },
  { upTo: 10, deep: "#3E434D", mid: "#767D8C", bright: "#AEB6C4", fire: "#D2D9E4" },
  { upTo: 12, deep: "#454B57", mid: "#8790A1", bright: "#C3CBD9", fire: "#E8EDF5" },
  { upTo: 13, deep: "#4A5160", mid: "#96A0B3", bright: "#D8E0EC", fire: "#FFFFFF" },
  // The coloured rarities. Champagne, cognac and canary are real fancy grades,
  // and this is where the stone stops being clear and starts being warm.
  { upTo: 14, deep: "#4A3E2E", mid: "#9C8161", bright: "#E4CDA6", fire: "#FFF3DE" },
  { upTo: 15, deep: "#4A3222", mid: "#9C6B42", bright: "#DFA871", fire: "#FFE2C0" },
  { upTo: 16, deep: "#4A4118", mid: "#A8912A", bright: "#F0DC72", fire: "#FFF6C4" },
  // The named stones.
  { upTo: 17, deep: "#3F3A22", mid: "#9A8C43", bright: "#E8D68A", fire: "#FFF8D6" },
  { upTo: 18, deep: "#2E3B45", mid: "#5B8398", bright: "#A8D0E4", fire: "#E6F7FF" },
  { upTo: 19, deep: "#3B2E45", mid: "#7C5B98", bright: "#C3A8E4", fire: "#F3E6FF" },
  { upTo: 20, deep: "#452E38", mid: "#985B72", bright: "#E4A8BF", fire: "#FFE6EE" },
  { upTo: 21, deep: "#1F4E5F", mid: "#3F9FBA", bright: "#9FE8F7", fire: "#FFFFFF" },
];

/**
 * Clamp to a real stage.
 *
 * `Math.max(NaN, 1)` is NaN, not 1, so a null or malformed level has to be
 * caught explicitly -- otherwise it propagates into the facet count and the
 * geometry is built from an empty array.
 */
function clampTier(level) {
  const numeric = Number(level);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(Math.max(Math.round(numeric), 1), 21);
}

function paletteFor(level) {
  const clamped = clampTier(level);
  return BANDS.find((band) => clamped <= band.upTo) ?? BANDS[BANDS.length - 1];
}

const TABLE_Y = 31;
const GIRDLE_Y = 47;
const TIP_Y = 90;
const TABLE_HALF = 20;
const GIRDLE_HALF = 37;

const poly = (points) => points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");

/** Evenly spaced x positions across a half-width, left to right. */
const across = (half, steps) =>
  Array.from({ length: steps + 1 }, (_, i) => 50 - half + (2 * half * i) / steps);

export default function LevelBadge({ level = 1, size = 48, name = null, className = "" }) {
  const tier = clampTier(level);
  const palette = paletteFor(tier);
  const id = `gem-${tier}-${size}`;

  // A rough stone has almost no faces; a brilliant is covered in them. Three
  // rising to eight, which is where more facets stop being legible at the 14px
  // chip size this is mostly seen at.
  const facets = Math.min(3 + Math.floor((tier - 1) / 3), 8);
  const cut = tier >= 4;

  const tableXs = across(TABLE_HALF, facets);
  const girdleXs = across(GIRDLE_HALF, facets);

  // The silhouette everyone recognises: flat table, crown flaring out to the
  // girdle, pavilion tapering to a point.
  const outline = [
    [50 - TABLE_HALF, TABLE_Y],
    [50 + TABLE_HALF, TABLE_Y],
    [50 + GIRDLE_HALF, GIRDLE_Y],
    [50, TIP_Y],
    [50 - GIRDLE_HALF, GIRDLE_Y],
  ];

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
        <linearGradient id={`${id}-body`} x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0%" stopColor={palette.bright} />
          <stop offset="50%" stopColor={palette.mid} />
          <stop offset="100%" stopColor={palette.deep} />
        </linearGradient>
        <linearGradient id={`${id}-table`} x1="0" y1="0" x2="0.7" y2="1">
          <stop offset="0%" stopColor={palette.fire === "none" ? palette.mid : palette.fire} />
          <stop offset="100%" stopColor={palette.bright} />
        </linearGradient>
        {palette.fire !== "none" && (
          <filter id={`${id}-glow`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation={tier === 21 ? 2.4 : 1.2} result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        )}
      </defs>

      <g filter={palette.fire !== "none" ? `url(#${id}-glow)` : undefined}>
        <polygon points={poly(outline)} fill={`url(#${id}-body)`} />

        {/* Pavilion facets: wedges from the girdle down to the point. Alternating
            opacity is what makes light look like it is bouncing inside. */}
        {cut && girdleXs.slice(0, -1).map((x, index) => (
          <polygon
            key={`p${index}`}
            points={poly([[x, GIRDLE_Y], [girdleXs[index + 1], GIRDLE_Y], [50, TIP_Y]])}
            fill={palette.bright}
            opacity={index % 2 === 0 ? 0.22 : 0.07}
          />
        ))}

        {/* Crown facets: the band between table and girdle. */}
        {cut && tableXs.slice(0, -1).map((x, index) => (
          <polygon
            key={`c${index}`}
            points={poly([
              [x, TABLE_Y], [tableXs[index + 1], TABLE_Y],
              [girdleXs[index + 1], GIRDLE_Y], [girdleXs[index], GIRDLE_Y],
            ])}
            fill={palette.bright}
            opacity={index % 2 === 0 ? 0.1 : 0.24}
          />
        ))}

        {/* The table, brightest face of the stone. */}
        <polygon
          points={poly([
            [50 - TABLE_HALF, TABLE_Y], [50 + TABLE_HALF, TABLE_Y],
            [50 + TABLE_HALF - 3, TABLE_Y + 3], [50 - TABLE_HALF + 3, TABLE_Y + 3],
          ])}
          fill={`url(#${id}-table)`}
        />

        <polygon points={poly(outline)} fill="none" stroke={palette.bright} strokeWidth="1.4" opacity="0.9" strokeLinejoin="round" />
        <line x1={50 - GIRDLE_HALF} y1={GIRDLE_Y} x2={50 + GIRDLE_HALF} y2={GIRDLE_Y} stroke={palette.bright} strokeWidth="1" opacity="0.55" />

        {/* One specular flash down the left crown. */}
        <polygon
          points={poly([[50 - TABLE_HALF, TABLE_Y], [50 - TABLE_HALF + 7, TABLE_Y], [50 - GIRDLE_HALF + 6, GIRDLE_Y], [50 - GIRDLE_HALF, GIRDLE_Y]])}
          fill="#FFFFFF"
          opacity="0.26"
        />
      </g>
    </svg>
  );
}

/** Compact badge plus name, for chat headers and list rows. */
export function LevelChip({ level, name, size = 16 }) {
  return (
    <span className="level-chip" title={name ?? "Growth stage"}>
      <LevelBadge level={level} size={size} name={name} />
      <span className="level-chip-name">{name}</span>
    </span>
  );
}
