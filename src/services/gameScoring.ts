import { env } from "../config/env";

/**
 * How Beat Breaker's boards add up from November 2026 — so a fan who plays an hour
 * or two most days can compete with one who plays all night:
 *  - A game counts for the day (UTC = Ghana time) it started on. Your best game
 *    each day is that day's score.
 *  - Days in a row build a streak: each one adds 5% to that day's score, up to
 *    +25% from the 6th day running.
 *  - The month's total — the prize board — is your best 20 days added up: playing
 *    most days beats one marathon, and missing a few doesn't knock you out.
 *  - Each week (Monday–Sunday) has its own board: every day that week adds up, and
 *    it starts again every Monday. Bragging rights and a 🏅 badge (services/flair) — no prize.
 * Earlier months ranked each player's single best game. (The game also gets harder
 * every level from 22, so a run ends when skill runs out, not stamina.)
 */
export const DAILY_FROM_MONTH = env.gameDailyFrom;
export const BEST_DAYS = 20;
export const STREAK_STEP = 0.05;
export const STREAK_MAX = 0.25;

export const isDailyMonth = (month: string) => month >= DAILY_FROM_MONTH;
export const isDay = (v: unknown): v is string => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

// ---------- Days and weeks (UTC = Ghana time) ----------

export const dayOf = (d = new Date()) => d.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400e3));
/** A week is named by its Monday, "YYYY-MM-DD". */
export const weekOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
export const weekStart = (week: string) => new Date(`${week}T00:00:00Z`);
/** First instant of the next week. */
export const weekEnd = (week: string) => new Date(`${addDays(week, 7)}T00:00:00Z`);

/** The first weekly board: the first Monday on the daily rules. */
export const WEEKLY_FROM = (() => {
  const first = `${DAILY_FROM_MONTH}-01`;
  const monday = weekOf(first);
  return monday === first ? first : addDays(monday, 7);
})();
export const hasWeeklyBoard = (week: string) => week >= WEEKLY_FROM;

/** Every week with at least one day in a month. */
export function weeksTouching(month: string): string[] {
  const out: string[] = [];
  for (let w = weekOf(`${month}-01`); w.slice(0, 7) <= month; w = addDays(w, 7)) out.push(w);
  return out;
}

// ---------- Points ----------

/** What a streak adds to a day's score: +5% for each day in a row after the first, up to +25%. */
export const streakBonus = (streak: number) => Math.min(Math.max(streak - 1, 0) * STREAK_STEP, STREAK_MAX);
export const bonusPct = (streak: number) => Math.round(streakBonus(streak) * 100);
/** A day's points: its best game plus the streak bonus. */
export const dayPoints = (best: number, streak: number) => Math.round(best * (1 + streakBonus(streak)));
/** The days that count towards a month: its best BEST_DAYS. */
export const countedDays = <T extends { points: number }>(days: T[]) =>
  [...days].sort((a, b) => b.points - a.points).slice(0, BEST_DAYS);
export const sumPoints = (days: { points: number }[]) => days.reduce((s, d) => s + d.points, 0);

/** The rules as the boards show them. */
export const SCORING = {
  bestDays: BEST_DAYS,
  streakStepPct: Math.round(STREAK_STEP * 100),
  streakMaxPct: Math.round(STREAK_MAX * 100),
  weeklyFrom: WEEKLY_FROM,
};
