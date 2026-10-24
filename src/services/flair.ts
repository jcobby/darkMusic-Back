import { Types } from "mongoose";
import { User, type IUser } from "../models/User";
import { GameWeek, GameSprint } from "../models/GameScore";
import { WalletTxn } from "../models/Wallet";
import { TriviaAttempt } from "../models/Trivia";
import { GameEvent } from "../models/GameEvent";
import { Squad } from "../models/Squad";
import { dayOf, addDays, weekOf } from "./gameScoring";

/**
 * Lenko Army flair — what a fan shows off next to their name on the boards:
 *  - a RANK from their longest daily check-in streak (it never drops back),
 *  - BADGES: 🏆 Beat Breaker months won, 🏅 weekly boards topped, ⚡ events won (weekly
 *    challenges, live tournaments), ⏱ daily sprint boards topped, 🧠 Lenko Trivia
 *    questions got right, 🔥 a check-in streak that's still going,
 *  - a NAME COLOUR they pick from the ones they've unlocked.
 * The daily check-in also pays more the longer the streak, with a bonus on each promotion.
 */

export const RANKS = [
  { name: "Recruit", days: 0 },
  { name: "Private", days: 3 },
  { name: "Corporal", days: 7 },
  { name: "Sergeant", days: 14 },
  { name: "Lieutenant", days: 30 },
  { name: "Captain", days: 60 },
  { name: "General", days: 100 },
] as const;

/** The rank a longest-ever streak has earned (an index into RANKS). */
export const rankIndex = (bestStreak: number) => RANKS.reduce((at, r, i) => (bestStreak >= r.days ? i : at), 0);

/** Points for checking in on the Nth day running. */
export const CHECKIN_TIERS = [
  { fromDay: 1, points: 5 },
  { fromDay: 3, points: 10 },
  { fromDay: 7, points: 15 },
  { fromDay: 14, points: 20 },
  { fromDay: 30, points: 25 },
] as const;
export const checkInPoints = (streak: number) => CHECKIN_TIERS.reduce((pts, t) => (streak >= t.fromDay ? t.points : pts), 5);
/** A promotion's one-off bonus: 10 points for every day of the streak it took. */
export const promotionBonus = (rank: number) => RANKS[rank].days * 10;

/** A check-in streak counts as live if they checked in today or yesterday. */
export const liveStreak = (u: Pick<IUser, "streak" | "lastCheckIn">) => {
  const today = dayOf();
  return u.lastCheckIn === today || u.lastCheckIn === addDays(today, -1) ? u.streak : 0;
};
export const bestStreakOf = (u: Pick<IUser, "streak" | "bestStreak">) => Math.max(u.bestStreak ?? 0, u.streak ?? 0);

/** A fan's wins, for badges and colour unlocks. */
interface Wins {
  months: number;
  weeks: number;
  events: number;
  sprints: number;
  trivia: number;
}

export const NAME_COLORS = {
  purple: { label: "Lenko purple", unlock: "a 7-day check-in streak", test: (best: number) => best >= 7 },
  emerald: { label: "Emerald", unlock: "a 30-day check-in streak", test: (best: number) => best >= 30 },
  gold: { label: "Champion gold", unlock: "topping a Beat Breaker board or winning an event", test: (_b: number, w: Wins) => w.weeks + w.months + w.events + w.sprints > 0 },
  sky: { label: "Trivia blue", unlock: "a right answer in Lenko Trivia", test: (_b: number, w: Wins) => w.trivia > 0 },
} as const;
export type NameColor = keyof typeof NAME_COLORS;
export const isNameColor = (v: unknown): v is NameColor => typeof v === "string" && Object.hasOwn(NAME_COLORS, v);
export const colorUnlocked = (c: NameColor, bestStreak: number, w: Wins) => NAME_COLORS[c].test(bestStreak, w);

// ---------- Wins (counted across everyone, kept for a few minutes) ----------

const NO_WINS: Wins = { months: 0, weeks: 0, events: 0, sprints: 0, trivia: 0 };
let winsCache: { at: number; byUser: Map<string, Wins> } | null = null;
const WINS_TTL = 5 * 60 * 1000;

/** Forget the counted wins (after DMY disqualifies someone, say). */
export const forgetWins = () => {
  winsCache = null;
};

async function allWins(): Promise<Map<string, Wins>> {
  if (winsCache && Date.now() - winsCache.at < WINS_TTL) return winsCache.byUser;
  type Count = { _id: Types.ObjectId; n: number };
  const [weeks, sprints, months, events, trivia] = await Promise.all([
    // Each finished week's top player (a tie goes to whoever got there first)
    GameWeek.aggregate<Count>([
      { $match: { score: { $gt: 0 }, disqualified: { $ne: true }, week: { $lt: weekOf(dayOf()) } } },
      { $sort: { week: 1, score: -1, achievedAt: 1 } },
      { $group: { _id: { game: "$game", week: "$week" }, user: { $first: "$user" } } },
      { $group: { _id: "$user", n: { $sum: 1 } } },
    ]),
    // Each finished day's top sprint
    GameSprint.aggregate<Count>([
      { $match: { score: { $gt: 0 }, disqualified: { $ne: true }, day: { $lt: dayOf() } } },
      { $sort: { day: 1, score: -1, achievedAt: 1 } },
      { $group: { _id: { game: "$game", day: "$day" }, user: { $first: "$user" } } },
      { $group: { _id: "$user", n: { $sum: 1 } } },
    ]),
    // Monthly prizes that stand (a disqualified winner's is void)
    WalletTxn.aggregate<Count>([{ $match: { kind: "prize", active: true } }, { $group: { _id: "$user", n: { $sum: 1 } } }]),
    // Events won: 1st place once the results are in
    GameEvent.aggregate<Count>([
      { $match: { settledAt: { $ne: null }, cancelled: { $ne: true } } },
      { $unwind: "$winners" },
      { $match: { "winners.place": 1 } },
      { $group: { _id: "$winners.user", n: { $sum: 1 } } },
    ]),
    // Right answers whose round is over (as the public trivia board shows them)
    TriviaAttempt.aggregate<Count>([{ $match: { result: "correct", deadline: { $lt: new Date() } } }, { $group: { _id: "$user", n: { $sum: 1 } } }]),
  ]);
  const byUser = new Map<string, Wins>();
  const add = (rows: Count[], key: keyof Wins) => {
    for (const r of rows) {
      const id = String(r._id);
      const w = byUser.get(id) ?? { ...NO_WINS };
      w[key] = r.n;
      byUser.set(id, w);
    }
  };
  add(weeks, "weeks");
  add(months, "months");
  add(events, "events");
  add(sprints, "sprints");
  add(trivia, "trivia");
  winsCache = { at: Date.now(), byUser };
  return byUser;
}

export async function winsOf(userId: string): Promise<Wins> {
  return (await allWins()).get(userId) ?? { ...NO_WINS };
}

// ---------- What the boards show ----------

/** The flair shown next to a name on the boards. */
export interface PublicFlair {
  rank: string;
  color: NameColor | null;
  streak: number; // live check-in streak (0 once broken)
  months: number;
  weeks: number;
  events: number;
  sprints: number;
  trivia: number;
  squad: string | null; // their squad's tag
}

type FlairUser = Pick<IUser, "streak" | "bestStreak" | "lastCheckIn" | "nameColor">;
export function flairOf(u: FlairUser, w: Wins, squad: string | null = null): PublicFlair {
  const best = bestStreakOf(u);
  const color = isNameColor(u.nameColor) && colorUnlocked(u.nameColor, best, w) ? u.nameColor : null;
  return { rank: RANKS[rankIndex(best)].name, color, streak: liveStreak(u), ...w, squad };
}

/** Squad tags by member (user id → tag). */
export async function squadTags(userIds: (string | Types.ObjectId)[]): Promise<Map<string, string>> {
  const ids = userIds.map(String);
  const squads = await Squad.find({ "members.user": { $in: ids } }).select("tag members.user").lean();
  const tags = new Map<string, string>();
  for (const s of squads) for (const m of s.members) tags.set(String(m.user), s.tag);
  return tags;
}

/** Flair for a page of players, by user id. */
export async function flairFor(userIds: (string | Types.ObjectId)[]): Promise<Map<string, PublicFlair>> {
  const ids = [...new Set(userIds.map(String))].filter((id) => Types.ObjectId.isValid(id));
  if (!ids.length) return new Map();
  const [users, wins, tags] = await Promise.all([
    User.find({ _id: { $in: ids } }).select("streak bestStreak lastCheckIn nameColor").lean(),
    allWins(),
    squadTags(ids),
  ]);
  return new Map(users.map((u) => [String(u._id), flairOf(u, wins.get(String(u._id)) ?? NO_WINS, tags.get(String(u._id)) ?? null)]));
}
