import crypto from "crypto";
import { Types } from "mongoose";
import { TriviaQuestion, TriviaRound, TriviaAttempt, TriviaSettings, type ITriviaAttempt } from "../models/Trivia";

/**
 * Lenko Trivia's live side — the LA End of Month Exam: the last day of every month
 * at 12:00 noon GMT (Ghana time), unless DMY moves that month's. While it's open,
 * each member taps once to get ONE question — their clock (`seconds`, 2 minutes)
 * starts at that tap and runs out even if that's after the session closes — and
 * answers once. No answer in time counts as wrong.
 */

export const GRACE_MS = 3_000; // network allowance on the answer deadline

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

// ---------- Settings (cached briefly; admin changes clear the cache) ----------

export interface TriviaConfig {
  open: boolean;
  sessionStartsAt: Date | null;
  sessionMinutes: number;
  seconds: number;
  prizeGhs: number;
  requireConfirmedEmail: boolean;
}
const DEFAULTS: TriviaConfig = { open: true, sessionStartsAt: null, sessionMinutes: 10, seconds: 120, prizeGhs: 1500, requireConfirmedEmail: true };
let settingsCache: { at: number; value: TriviaConfig } | null = null;

export async function triviaSettings(): Promise<TriviaConfig> {
  if (settingsCache && Date.now() - settingsCache.at < 10_000) return settingsCache.value;
  const doc = await TriviaSettings.findById("settings").lean();
  const value: TriviaConfig = {
    open: doc?.open ?? DEFAULTS.open,
    sessionStartsAt: doc?.sessionStartsAt ?? DEFAULTS.sessionStartsAt,
    sessionMinutes: doc?.sessionMinutes ?? DEFAULTS.sessionMinutes,
    seconds: doc?.seconds ?? DEFAULTS.seconds,
    prizeGhs: doc?.prizeGhs ?? DEFAULTS.prizeGhs,
    requireConfirmedEmail: doc?.requireConfirmedEmail ?? DEFAULTS.requireConfirmedEmail,
  };
  settingsCache = { at: Date.now(), value };
  return value;
}
export const forgetTriviaSettings = () => {
  settingsCache = null;
};

// ---------- The session ----------

export type SessionStatus = "none" | "upcoming" | "open" | "over";

/** 12:00 GMT on the last day of `now`'s month. */
export function monthEndNoon(now = Date.now()) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12, 0, 0));
}

/** This month's exam: the time DMY moved it to (if that's in this month), otherwise the last day at noon. */
export function sessionStart(s: TriviaConfig, now = Date.now()) {
  const month = new Date(now).toISOString().slice(0, 7);
  return s.sessionStartsAt && s.sessionStartsAt.toISOString().slice(0, 7) === month ? s.sessionStartsAt : monthEndNoon(now);
}

/** This month's session and where it's at: coming up, open (members can start their question) or over (the next month's comes up at midnight). */
export function sessionOf(s: TriviaConfig, now = Date.now()) {
  const startsAt = sessionStart(s, now);
  const endsAt = new Date(startsAt.getTime() + s.sessionMinutes * 60e3);
  const status: SessionStatus = now < startsAt.getTime() ? "upcoming" : now < endsAt.getTime() ? "open" : "over";
  return { status, startsAt, endsAt };
}

/** The session's key — one round per session. */
const sessionKey = (s: TriviaConfig) => sessionStart(s).toISOString();

/** This session's round, if anyone has started a question in it. */
export const findSessionRound = (s: TriviaConfig) => TriviaRound.findOne({ session: sessionKey(s) });

/** This session's round, made with the first question (a number clash, e.g. two first taps at once, just tries again). */
async function sessionRound(s: TriviaConfig) {
  const { startsAt, endsAt } = sessionOf(s);
  for (let tries = 0; ; tries++) {
    const found = await TriviaRound.findOne({ session: sessionKey(s) });
    if (found) return found;
    const last = await TriviaRound.findOne().sort({ number: -1 }).select("number").lean();
    try {
      return await TriviaRound.create({
        number: (last?.number ?? 0) + 1,
        session: sessionKey(s),
        startedAt: startsAt,
        endsAt: new Date(endsAt.getTime() + s.seconds * 1000), // the last question that can be started runs to here
        players: 0,
      });
    } catch (err) {
      if (tries >= 4 || (err as { code?: number }).code !== 11000) throw err;
    }
  }
}

/**
 * "Start my question": this member's one question for the session, and their clock from
 * now. A second tap (or another tab) gets the same question back, never a new one. They
 * get a question they've never had, spread across the live ones so players in the
 * session mostly get different ones (with one live question, everyone gets it).
 */
export async function startQuestion(userId: string, name: string, ip: string): Promise<ITriviaAttempt> {
  const s = await triviaSettings();
  const { status } = sessionOf(s);
  if (!s.open) throw httpError(409, "The LA End of Month Exam is paused right now — check back soon");
  if (status === "upcoming") throw httpError(409, "It hasn't opened yet — come back when the exam starts");
  if (status !== "open") throw httpError(409, "This month's exam is over — the next one is at 12:00 on the last day of next month");

  const round = await sessionRound(s);
  const uid = new Types.ObjectId(userId);
  const mine = await TriviaAttempt.findOne({ round: round._id, user: uid });
  if (mine) return mine;

  const [active, had, used] = await Promise.all([
    activeQuestionIds(),
    TriviaAttempt.distinct("question", { user: uid }).then((ids) => new Set(ids.map(String))),
    TriviaAttempt.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { round: round._id } }, { $group: { _id: "$question", n: { $sum: 1 } } }]),
  ]);
  if (!active.length) throw httpError(409, "The questions aren't up yet — try again in a moment");
  const options = active.filter((q) => !had.has(q));
  if (!options.length) throw httpError(409, "You've already had every question in this session");
  const count = new Map(used.map((u) => [String(u._id), u.n]));
  const fewest = Math.min(...options.map((q) => count.get(q) ?? 0));
  const least = options.filter((q) => (count.get(q) ?? 0) === fewest);
  const pick = least[crypto.randomInt(least.length)];

  const assignedAt = new Date();
  try {
    const a = await TriviaAttempt.create({
      round: round._id,
      roundNumber: round.number,
      user: uid,
      name,
      question: pick,
      assignedAt,
      deadline: new Date(assignedAt.getTime() + s.seconds * 1000),
      result: "pending",
      ip,
    });
    await Promise.all([
      TriviaRound.updateOne({ _id: round._id }, { $inc: { players: 1 } }),
      TriviaQuestion.updateOne({ _id: pick }, { $inc: { asked: 1 } }),
    ]);
    return a;
  } catch (err) {
    // Two taps at the same moment: the other one won — that's their question
    if ((err as { code?: number }).code !== 11000) throw err;
    const won = await TriviaAttempt.findOne({ round: round._id, user: uid });
    if (!won) throw err;
    return won;
  }
}

// ---------- The question bank, closing answers ----------

let activeCache: { at: number; ids: string[] } | null = null;
export async function activeQuestionIds(): Promise<string[]> {
  if (activeCache && Date.now() - activeCache.at < 10_000) return activeCache.ids;
  const ids = (await TriviaQuestion.find({ active: true }).select("_id").lean()).map((q) => String(q._id));
  activeCache = { at: Date.now(), ids };
  return ids;
}
export const forgetActiveQuestions = () => {
  activeCache = null;
};

/** Time's up: lock unanswered questions (one player, or everyone). */
export async function closeExpired(userId?: string) {
  const cutoff = new Date(Date.now() - GRACE_MS);
  await TriviaAttempt.updateMany(
    { result: "pending", deadline: { $lt: cutoff }, ...(userId ? { user: new Types.ObjectId(userId) } : {}) },
    { $set: { result: "unanswered" } }
  );
}

// ---------- Checking an answer ----------

/** Lowercase, no accents or punctuation, "&" = "and", no leading "the/a/an", single spaces. */
export function normalizeAnswer(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^(the|a|an) /, "")
    .replace(/\s+/g, " ");
}

/** Edit distance, stopping early once it's over `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Right if it matches an accepted answer once case, accents, punctuation and a
 * leading "the" are ignored — or is one letter off for answers of 6+ letters
 * (a typo in a name). Never for answers with numbers in them ("Okese2" isn't
 * "Okese1", 2025 isn't 2026). DMY can still mark any answer right or wrong by hand.
 */
export function isCorrectAnswer(given: string, accepted: string[]): boolean {
  const g = normalizeAnswer(given);
  if (!g) return false;
  return accepted.some((a) => {
    const n = normalizeAnswer(a);
    if (!n) return false;
    if (n === g || n.replace(/ /g, "") === g.replace(/ /g, "")) return true; // "Xlim Kid" = "XlimKid"
    if (/\d/.test(n) || /\d/.test(g)) return false;
    return n.replace(/ /g, "").length >= 6 && distance(n, g, 1) <= 1;
  });
}
