// A quiet per-friendship rhythm marker. The count is informational; it does not
// warn people that a relationship or earned progress is about to expire.

export default function StreakFlame({ streak, className = "" }) {
  if (!streak?.days) return null;
  const { days } = streak;
  const label = `${days}-day shared rhythm`;
  return (
    <span
      className={`streak-flame ${className}`}
      title={`Shared rhythm: ${days} days`}
      aria-label={label}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17.2a6.2 6.2 0 1 0-6.2-6.2c0 3.4 2.8 6.2 6.2 6.2Z" /><path d="M10 13.9a2.9 2.9 0 1 0 0-5.8c-1.6 1.1-2.2 2.1-2.2 3.1" /></svg>
      {days}
    </span>
  );
}
