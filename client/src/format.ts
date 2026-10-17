const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A short, rounded duration: "1 min", "10 min", "3 h", "4 d", "2 mo", "1.5 y". */
export function formatInterval(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))} min`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} h`;
  if (ms < 30 * DAY) return `${Math.round(ms / DAY)} d`;
  if (ms < 365 * DAY) return `${Math.round(ms / (30 * DAY))} mo`;
  return `${Math.round((ms / (365 * DAY)) * 10) / 10} y`;
}
