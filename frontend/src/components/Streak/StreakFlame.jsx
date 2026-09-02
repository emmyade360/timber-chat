// A per-friendship streak, as a flame and a day count.
//
// Shown only once a streak actually exists, so an empty chat list stays quiet.
// `at_risk` is the state the whole mechanic turns on -- both people sent
// yesterday and only one of them has today -- so it reads differently.

export default function StreakFlame({ streak, className = "" }) {
  if (!streak?.days) return null;
  const { days, at_risk: atRisk } = streak;
  const label = atRisk
    ? `${days}-day streak, ends tonight unless you both send`
    : `${days}-day streak`;
  return (
    <span
      className={`streak-flame ${atRisk ? "streak-flame--at-risk" : ""} ${className}`}
      title={label}
      aria-label={label}
    >
      <span aria-hidden="true">{"\u{1F525}"}</span>
      {days}
    </span>
  );
}
