export interface SrsState {
  interval: number; // days until next review when answered "know"
  ease: number; // ease factor (SM-2), default 2.5
  reps: number; // total review count
  lapses: number; // times a learned card was forgotten
}

export interface SrsResult extends SrsState {
  dueAt: string; // "YYYY-MM-DD HH:MM:SS" UTC
}

export const LEARN_AGAIN_MINUTES = 10;
export const MIN_EASE = 1.3;

function toDb(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

export function nextSchedule(
  state: SrsState,
  result: "again" | "know",
  now: Date = new Date()
): SrsResult {
  let { interval, ease, reps, lapses } = state;
  reps += 1;
  if (result === "again") {
    lapses += 1;
    ease = Math.max(MIN_EASE, Math.round((ease - 0.2) * 100) / 100);
    interval = 0;
    return { interval, ease, reps, lapses, dueAt: toDb(now.getTime() + LEARN_AGAIN_MINUTES * 60_000) };
  }
  interval =
    interval === 0 ? 1 : interval === 1 ? 2 : Math.max(2, Math.round(interval * ease));
  return { interval, ease, reps, lapses, dueAt: toDb(now.getTime() + interval * 86_400_000) };
}

export function boxFor(interval: number): number {
  if (interval >= 60) return 5;
  if (interval >= 21) return 4;
  if (interval >= 7) return 3;
  if (interval >= 3) return 2;
  if (interval >= 1) return 1;
  return 0;
}

export function intervalForBox(box: number): number {
  if (box >= 5) return 60;
  if (box >= 4) return 21;
  if (box >= 3) return 7;
  if (box >= 2) return 3;
  if (box >= 1) return 1;
  return 0;
}

export function intervalLabel(interval: number): string {
  if (interval === 0) return "Learning";
  if (interval === 1) return "1 day";
  if (interval < 7) return `${interval} days`;
  const weeks = Math.round(interval / 7);
  if (interval < 30) return `${weeks} week${weeks === 1 ? "" : "s"}`;
  const months = Math.round(interval / 30);
  if (interval < 365) return `${months} month${months === 1 ? "" : "s"}`;
  const years = Math.round(interval / 365);
  return `${years} year${years === 1 ? "" : "s"}`;
}

export function isDue(dueAt: string, now: Date = new Date()): boolean {
  if (!dueAt) return true; // new/unscheduled cards are due immediately
  const t = Date.parse(dueAt.replace(" ", "T") + "Z");
  return Number.isNaN(t) || t <= now.getTime();
}

export function dueLabel(dueAt: string): string {
  const t = Date.parse(dueAt.replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return "now";
  const diff = t - Date.now();
  if (diff <= 0) return "due now";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${intervalLabel(days)}`;
}
