/** Chat-list timestamp: clock today, "Yesterday", weekday this week, date beyond. */
export function timeAgo(timestamp: number | null | undefined): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const now = new Date();

  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";

  if (now.getTime() - date.getTime() < 7 * 86_400_000) return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString([], { day: "numeric", month: "short" });
}
