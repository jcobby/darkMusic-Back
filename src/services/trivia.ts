import { Types } from "mongoose";
import { TriviaQuestion, TriviaRound, TriviaAttempt, TriviaSettings } from "../models/Trivia";

/**
 * Lenko Trivia's live side: who's in the lobby right now, starting a round when
 * enough of them are ready at the same time, handing out questions and checking
 * answers.
 *
 * "Ready" lives in this server's memory: each ready player's page checks in every
 * couple of seconds, and anyone not heard from for STALE_MS has left. The site
 * runs as one server, so this is exact — and a restart only empties the lobby
 * (players tap Ready again); rounds and answers are in the database.
 */

export const STALE_MS = 15_000;
export const GRACE_MS = 3_000; // network allowance on the answer deadline

// ---------- Settings (cached briefly; admin changes clear the cache) ----------

export interface TriviaConfig {
  open: boolean;
  minPlayers: number;
  seconds: number;
  prizeGhs: number;
  requireConfirmedEmail: boolean;
}
const DEFAULTS: TriviaConfig = { open: true, minPlayers: 10, seconds: 120, prizeGhs: 1000, requireConfirmedEmail: true };
let settingsCache: { at: number; value: TriviaConfig } | null = null;

export async function triviaSettings(): Promise<TriviaConfig> {
  if (settingsCache && Date.now() - settingsCache.at < 10_000) return settingsCache.value;
  const doc = await TriviaSettings.findById("settings").lean();
  const value: TriviaConfig = {
    open: doc?.open ?? DEFAULTS.open,
    minPlayers: doc?.minPlayers ?? DEFAULTS.minPlayers,
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

// ---------- The lobby ----------

interface ReadyPlayer {
  name: string;
  ip: string;
  readyAt: number;
  seenAt: number;
}
const lobby = new Map<string, ReadyPlayer>();
/**
 * Players just handed a question, until their time is up — kept here so the next
 * check-in from their page carries the question straight back (no extra request
 * from everyone at the same moment when a round starts).
 */
export interface LiveQuestion {
  attemptId: string;
  roundNumber: number;
  text: string;
  deadline: number; // ms
}
const live = new Map<string, LiveQuestion>();

function prune(now = Date.now()) {
  for (const [id, p] of lobby) if (now - p.seenAt > STALE_MS) lobby.delete(id);
  for (const [id, q] of live) if (q.deadline + GRACE_MS < now) live.delete(id);
}

export function lobbyView() {
  prune();
  const players = [...lobby.values()].sort((a, b) => a.readyAt - b.readyAt);
  return { ready: players.length, names: players.slice(0, 12).map((p) => p.name) };
}
export const isInLobby = (userId: string) => {
  prune();
  return lobby.has(userId);
};
/** The player's page checked in: still here. */
export function seen(userId: string) {
  const p = lobby.get(userId);
  if (p) p.seenAt = Date.now();
}
export function joinLobby(userId: string, name: string, ip: string) {
  const now = Date.now();
  lobby.set(userId, { name, ip, readyAt: lobby.get(userId)?.readyAt ?? now, seenAt: now });
}
export const leaveLobby = (userId: string) => lobby.delete(userId);
/** The question this player was just given, while it's live. */
export const liveQuestion = (userId: string): LiveQuestion | null => {
  prune();
  return live.get(userId) ?? null;
};
export const doneWithQuestion = (userId: string) => live.delete(userId);

// ---------- Starting a round ----------

const shuffle = <T>(list: T[]): T[] => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

let starting: Promise<void> | null = null;

/**
 * Start a round if enough players are ready right now. Only one check runs at a
 * time (set before any waiting), so players checking in at the same instant can
 * never start two rounds; everyone calling meanwhile waits for that one.
 */
export function maybeStartRound(): Promise<void> {
  if (!starting) {
    starting = (async () => {
      const s = await triviaSettings();
      prune();
      if (!s.open || lobby.size < s.minPlayers) return;
      await startRound(s);
    })()
      .catch((err) => console.error("[trivia] couldn't start a round:", err))
      .finally(() => {
        starting = null;
      });
  }
  return starting;
}

/** The next round number (retries if a number is taken, e.g. two servers during a deploy). */
async function createRound(startedAt: Date, endsAt: Date) {
  for (let tries = 0; ; tries++) {
    const last = await TriviaRound.findOne().sort({ number: -1 }).select("number").lean();
    try {
      return await TriviaRound.create({ number: (last?.number ?? 0) + 1, startedAt, endsAt, players: 0 });
    } catch (err) {
      if (tries >= 4 || (err as { code?: number }).code !== 11000) throw err;
    }
  }
}

/**
 * Everyone ready right now goes into the round. Each gets a question they've never
 * had, spread across the bank so players in the same round mostly get different
 * ones, and the same deadline.
 */
async function startRound(s: TriviaConfig) {
  const now = Date.now();
  prune(now);
  const players = shuffle([...lobby.entries()]);
  if (players.length < s.minPlayers) return;
  for (const [id] of players) lobby.delete(id);

  const ids = players.map(([id]) => new Types.ObjectId(id));
  const [active, history] = await Promise.all([
    TriviaQuestion.find({ active: true }).select("_id text").lean(),
    TriviaAttempt.find({ user: { $in: ids } }).select("user question").lean(),
  ]);
  const had = new Map<string, Set<string>>();
  for (const a of history) {
    const k = String(a.user);
    if (!had.has(k)) had.set(k, new Set());
    had.get(k)!.add(String(a.question));
  }

  // The clock starts after the slow reads, so nobody loses seconds while the round is set up.
  const startedAt = new Date();
  const deadline = new Date(startedAt.getTime() + s.seconds * 1000);
  const round = await createRound(startedAt, deadline);
  const number = round.number;

  const used = new Map<string, number>(); // how many players got each question this round
  const attempts = [];
  for (const [id, p] of players) {
    const mine = had.get(id);
    const options = active.map((q) => String(q._id)).filter((q) => !mine?.has(q));
    if (!options.length) continue; // they've had every question (checked when they got ready)
    const fewest = Math.min(...options.map((q) => used.get(q) ?? 0));
    const pick = shuffle(options.filter((q) => (used.get(q) ?? 0) === fewest))[0];
    used.set(pick, (used.get(pick) ?? 0) + 1);
    attempts.push({
      round: round._id,
      roundNumber: number,
      user: id,
      name: p.name,
      question: pick,
      assignedAt: startedAt,
      deadline,
      result: "pending" as const,
      ip: p.ip,
    });
  }
  const saved = attempts.length ? await TriviaAttempt.insertMany(attempts, { ordered: false }) : [];
  await TriviaRound.updateOne({ _id: round._id }, { $set: { players: saved.length } });
  if (used.size) {
    await TriviaQuestion.bulkWrite(
      [...used].map(([q, n]) => ({ updateOne: { filter: { _id: new Types.ObjectId(q) }, update: { $inc: { asked: n } } } }))
    );
  }
  const textOf = new Map(active.map((q) => [String(q._id), q.text]));
  for (const a of saved) {
    live.set(String(a.user), {
      attemptId: String(a._id),
      roundNumber: number,
      text: textOf.get(String(a.question)) ?? "",
      deadline: deadline.getTime(),
    });
  }
  console.log(`[trivia] round ${number} started: ${saved.length} players, ${used.size} questions`);
}

// ---------- Questions left, closing answers ----------

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

/** How many live questions this player hasn't had yet. */
export async function questionsLeft(userId: string): Promise<number> {
  const [ids, had] = await Promise.all([
    activeQuestionIds(),
    TriviaAttempt.distinct("question", { user: new Types.ObjectId(userId) }),
  ]);
  const seenSet = new Set(had.map(String));
  return ids.filter((id) => !seenSet.has(id)).length;
}

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
