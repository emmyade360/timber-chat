// One component, twenty-one diamonds.
//
// A brilliant cut seen face-on: the flat table in the middle, a ring of crown
// facets around it, and the girdle at the rim. Stages advance along four axes
// that stack, so the ladder reads as a climb rather than as twenty-one unrelated
// pictures -- the stone gains facets as it is cut, the palette walks from dead
// graphite through white fire into saturated rarities, the glow widens, and the
// top stones pick up sparkle, dispersion and a moving shimmer.
//
// Drawn parametrically rather than as twenty-one assets, so rebalancing the
// ladder is a table edit and the same component works from a 14px chip beside a
// username to a 128px celebration.

// One entry per stage, indexed by level. `fire` is the sparkle only a polished
// stone gets; `null` keeps the early stones dull on purpose -- stage one has to
// look like something you want to leave behind.
const STONES = [
  // Formation: carbon and rough stone. Grey, unlit, barely faceted.
  { deep: "#141517", mid: "#212327", bright: "#313438", fire: null }, //  1 Carbon
  { deep: "#1A1917", mid: "#2A2724", bright: "#3E3832", fire: null }, //  2 Ember
  { deep: "#212327", mid: "#34373D", bright: "#4E525A", fire: null }, //  3 Rough
  { deep: "#272A30", mid: "#3F434B", bright: "#616670", fire: null }, //  4 Glint
  { deep: "#2D3138", mid: "#4A4F59", bright: "#737985", fire: null }, //  5 Facet
  // Craft: the cut starts catching light, and the stone earns its first fire.
  { deep: "#333841", mid: "#565C68", bright: "#858C99", fire: "#A3ABB8" }, //  6 Baguette
  { deep: "#383E49", mid: "#626977", bright: "#959DAB", fire: "#B7BFCD" }, //  7 Cushion
  { deep: "#3D4453", mid: "#6E7687", bright: "#A5AEBE", fire: "#C9D1DE" }, //  8 Princess
  { deep: "#424A5B", mid: "#7A8396", bright: "#B4BECF", fire: "#D8DFEC" }, //  9 Marquise
  { deep: "#475063", mid: "#8690A5", bright: "#C3CDDD", fire: "#E6ECF7" }, // 10 Asscher
  { deep: "#4B556B", mid: "#929DB4", bright: "#D1DBEA", fire: "#F2F6FF" }, // 11 Radiant
  { deep: "#4F5A73", mid: "#9EAAC2", bright: "#DFE7F4", fire: "#FFFFFF" }, // 12 Solitaire
  { deep: "#535F7A", mid: "#AAB7D0", bright: "#ECF2FF", fire: "#FFFFFF" }, // 13 Brilliant
  // The coloured rarities. Champagne, cognac and canary are real fancy grades,
  // and this is where the stone stops being clear and starts being warm.
  { deep: "#4A3E2E", mid: "#A98C68", bright: "#EED8B4", fire: "#FFF6E4" }, // 14 Champagne
  { deep: "#4E3220", mid: "#AE7345", bright: "#EDB47B", fire: "#FFE8CB" }, // 15 Cognac
  { deep: "#514613", mid: "#BCA22E", bright: "#FBE87C", fire: "#FFFBCE" }, // 16 Canary
  // The named stones: saturated, lit from inside, unmistakable across a room.
  { deep: "#0F5138", mid: "#22AC74", bright: "#71F5BE", fire: "#DEFFF2" }, // 17 Sancy
  { deep: "#0A4A63", mid: "#199FD0", bright: "#69E4FF", fire: "#DCFAFF" }, // 18 Orlov
  { deep: "#331A66", mid: "#7A45E0", bright: "#BB9BFF", fire: "#F1E7FF" }, // 19 Regent
  { deep: "#5C0F45", mid: "#DB2F9C", bright: "#FF8FD5", fire: "#FFE2F3" }, // 20 Cullinan
  { deep: "#8A5605", mid: "#FFC44D", bright: "#FFF6D2", fire: "#FFFFFF" }, // 21 Koh-i-Noor
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
  return STONES[clampTier(level) - 1];
}

const TABLE_Y = 31;
const GIRDLE_Y = 47;
const TIP_Y = 90;
const TABLE_HALF = 20;
const GIRDLE_HALF = 37;

// Sparkle flashes, brightest first. Higher stages light more of them.
const SPARKS = [
  { x: 74, y: 23, r: 9 },
  { x: 24, y: 20, r: 6 },
  { x: 85, y: 62, r: 6 },
  { x: 14, y: 58, r: 5 },
];

const poly = (points) => points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");

/** Evenly spaced x positions across a half-width, left to right. */
const across = (half, steps) =>
  Array.from({ length: steps + 1 }, (_, i) => 50 - half + (2 * half * i) / steps);

/** A four-point star: long spikes, pinched waist, the shape light makes. */
const spark = ({ x, y, r }) =>
  poly([
    [x, y - r], [x + r * 0.3, y - r * 0.3], [x + r, y], [x + r * 0.3, y + r * 0.3],
    [x, y + r], [x - r * 0.3, y + r * 0.3], [x - r, y], [x - r * 0.3, y - r * 0.3],
  ]);

export default function LevelBadge({ level = 1, size = 48, name = null, className = "" }) {
  const tier = clampTier(level);
  const palette = paletteFor(tier);
  const id = `gem-${tier}-${size}`;

  // A rough stone has almost no faces; a brilliant is covered in them. Three
  // rising to nine, which is where more facets stop being legible at the 14px
  // chip size this is mostly seen at.
  const facets = Math.min(3 + Math.floor((tier - 1) / 2), 9);
  const cut = tier >= 4;

  // Each effect switches on at the stage where the stone deserves it, so the
  // climb keeps producing something new to notice right to the top.
  const lit = palette.fire !== null;
  const blur = lit ? Number((0.7 + (tier - 6) * 0.17).toFixed(2)) : 0;
  const sparks = tier >= 21 ? 4 : tier >= 18 ? 3 : tier >= 15 ? 2 : tier >= 12 ? 1 : 0;
  const dispersion = tier >= 18;
  const shimmer = tier >= 17;
  const halo = tier >= 20;
  const prism = 0.3 + (tier - 18) * 0.07;

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
      className={`level-badge ${shimmer ? "level-badge--flashy" : ""} ${className}`}
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
          <stop offset="0%" stopColor={palette.fire ?? palette.mid} />
          <stop offset="100%" stopColor={palette.bright} />
        </linearGradient>
        {lit && (
          <filter id={`${id}-glow`} x="-45%" y="-45%" width="190%" height="190%">
            <feGaussianBlur stdDeviation={blur} result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        )}
        {(dispersion || shimmer) && (
          <clipPath id={`${id}-clip`}>
            <polygon points={poly(outline)} />
          </clipPath>
        )}
        {/* Dispersion: white light split into its colours on the way out of the
            stone. Only the rarest stages throw it. */}
        {dispersion && (
          <linearGradient id={`${id}-prism`} x1="0" y1="0" x2="1" y2="0.6">
            <stop offset="0%" stopColor="#FF4D6D" />
            <stop offset="25%" stopColor="#FFD166" />
            <stop offset="50%" stopColor="#5CE1A6" />
            <stop offset="75%" stopColor="#4CC9F0" />
            <stop offset="100%" stopColor="#B892FF" />
          </linearGradient>
        )}
        {shimmer && (
          <linearGradient id={`${id}-sweep`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0" />
            <stop offset="50%" stopColor="#FFFFFF" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>
        )}
      </defs>

      <g filter={lit ? `url(#${id}-glow)` : undefined}>
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

        {dispersion && (
          <polygon
            points={poly(outline)}
            fill={`url(#${id}-prism)`}
            opacity={prism.toFixed(2)}
            clipPath={`url(#${id}-clip)`}
            style={{ mixBlendMode: "screen" }}
          />
        )}

        {/* The table, brightest face of the stone. */}
        <polygon
          points={poly([
            [50 - TABLE_HALF, TABLE_Y], [50 + TABLE_HALF, TABLE_Y],
            [50 + TABLE_HALF - 3, TABLE_Y + 3], [50 - TABLE_HALF + 3, TABLE_Y + 3],
          ])}
          fill={`url(#${id}-table)`}
        />

        <polygon
          points={poly(outline)}
          fill="none"
          stroke={palette.fire ?? palette.bright}
          strokeWidth={lit ? 1.6 : 1.4}
          opacity="0.9"
          strokeLinejoin="round"
        />
        {halo && (
          <polygon points={poly(outline)} fill="none" stroke={palette.fire} strokeWidth={tier === 21 ? 5 : 4} opacity={tier === 21 ? 0.3 : 0.2} strokeLinejoin="round" />
        )}
        <line x1={50 - GIRDLE_HALF} y1={GIRDLE_Y} x2={50 + GIRDLE_HALF} y2={GIRDLE_Y} stroke={palette.bright} strokeWidth="1" opacity="0.55" />

        {/* One specular flash down the left crown. */}
        <polygon
          points={poly([[50 - TABLE_HALF, TABLE_Y], [50 - TABLE_HALF + 7, TABLE_Y], [50 - GIRDLE_HALF + 6, GIRDLE_Y], [50 - GIRDLE_HALF, GIRDLE_Y]])}
          fill="#FFFFFF"
          opacity="0.26"
        />

        {shimmer && (
          <g clipPath={`url(#${id}-clip)`}>
            <polygon
              className="level-badge-sweep"
              points={poly([[-24, 20], [-6, 20], [12, 95], [-6, 95]])}
              fill={`url(#${id}-sweep)`}
              opacity="0.5"
            />
          </g>
        )}
      </g>

      {/* Sparkles sit outside the glow group so they stay crisp points of light
          rather than smearing into the stone's halo. */}
      {SPARKS.slice(0, sparks).map((point, index) => (
        <polygon
          key={`s${index}`}
          className="level-badge-spark"
          points={spark(point)}
          fill={palette.fire ?? "#FFFFFF"}
          opacity={1 - index * 0.12}
          style={{ animationDelay: `${index * 0.45}s` }}
        />
      ))}
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
