// How far through the current stage someone is.
//
// This is the only place progression is quantified in the interface. Stages are
// named, never numbered: "Cedar" says something, "stage 9 of 21" turns a slow,
// deliberately unhurried practice into a completion percentage and invites
// people to compare. The bar carries the same information without the scoreboard.

import LevelBadge from "./LevelBadge.jsx";

/**
 * @param {object} me            the current user's profile
 * @param {"row"|"hero"} variant `row` sits inline in a list; `hero` is the big one
 * @param {boolean} showBadge    draw the growth-ring badge beside the name
 */
export default function GrowthBar({ me, variant = "row", showBadge = true, badgeSize = 40 }) {
  if (!me) return null;
  const atMax = !me.next_level_name;
  const span = me.growth_for_stage || 1;
  const percent = atMax ? 100 : Math.min(100, Math.round((me.growth_into_stage / span) * 100));

  return (
    <div className={`growth ${variant === "hero" ? "growth--hero" : ""}`}>
      {showBadge && <LevelBadge level={me.level} size={badgeSize} name={me.level_name} />}
      <div className="growth-body">
        <div className="growth-labels">
          <span className="growth-name">{me.level_name}</span>
          {!atMax && <span className="growth-next">{me.next_level_name}</span>}
        </div>
        <div
          className="growth-track"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={atMax ? `${me.level_name}, complete` : `Progress towards ${me.next_level_name}`}
        >
          <span className={`growth-fill ${atMax ? "growth-fill--full" : ""}`} style={{ width: `${percent}%` }} />
        </div>
        {variant === "hero" && (
          <p className="growth-caption">
            {atMax ? "Your path is complete." : `Growing towards ${me.next_level_name}.`}
          </p>
        )}
      </div>
    </div>
  );
}
