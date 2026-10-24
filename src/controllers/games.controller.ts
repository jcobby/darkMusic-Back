import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { Readable } from "stream";
import type { ReadableStream as NodeReadableStream } from "stream/web";
import jwt from "jsonwebtoken";
import { Schema, model, Types, type Model } from "mongoose";
import { env } from "../config/env";
import { GameTrack, type IGameTrack } from "../models/GameTrack";
import { gameTrackUrl } from "../services/cloudinary";
import { GameScore, GameWeek, GameDay, GameSprint, type IBoardEntry, type IGameDay } from "../models/GameScore";
import { User, type IUser } from "../models/User";
import { WalletTxn } from "../models/Wallet";
import { bidderName } from "./auction.controller";
import {
  GAME_PRIZE,
  BOARD_ORDER,
  ranked,
  monthOf,
  prevMonth,
  monthEnd,
  monthLabel,
  poolFor,
  settlePrize,
  reassessWinner,
} from "../services/prizes";
import {
  SCORING,
  isDailyMonth,
  isDay,
  dayOf,
  addDays,
  weekOf,
  weekStart,
  weekEnd,
  hasWeeklyBoard,
  weeksTouching,
  bonusPct,
  dayPoints,
  countedDays,
  sumPoints,
} from "../services/gameScoring";
import { flairFor, forgetWins } from "../services/flair";
import { recordEventGame } from "../services/events";

export { GAME_PRIZE };

// Beat Breaker scoring limits (mirror of the game): 8 bricks per row, rows = min(4 + level, 9),
// a brick is worth at most 50 (gold) × 3 (on the kick of the Beat of the Day), and clearing
// level L adds 100 × L.
const BRICKS_PER_ROW = 8;
const MAX_POINTS_PER_BRICK = 150;
const MIN_SECONDS_PER_LEVEL = 12; // nobody clears a wall faster than this
const RUN_TTL_SECONDS = 12 * 3600; // the best players' runs last hours

/** A sprint is a 15-minute game with its own daily board; saves get a minute's grace to arrive. */
export const SPRINT_SECONDS = 15 * 60;
const SPRINT_GRACE_SECONDS = 60;

/** Highest score a run could possibly reach by the end of `level`. */
export function maxScoreForLevel(level: number): number {
  let total = 0;
  for (let l = 1; l <= level; l++) {
    const rows = Math.min(4 + l, 9);
    total += rows * BRICKS_PER_ROW * MAX_POINTS_PER_BRICK + 100 * l;
  }
  return total;
}

const parseMonth = (v: unknown) => (/^\d{4}-\d{2}$/.test(String(v || "")) ? String(v) : monthOf());
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

// A run's progress as it's saved (its score only goes up). Kept for two days after the last save.
const gameRunSchema = new Schema({
  nonce: { type: String, required: true, unique: true },
  user: { type: Schema.Types.ObjectId, required: true },
  score: { type: Number, default: 0 },
  level: { type: Number, default: 1 },
  savedAt: { type: Date, default: Date.now, expires: 2 * 86400 },
});
const GameRun = model("GameRun", gameRunSchema);

interface RunToken {
  uid: string;
  game: string;
  startedAt: number;
  nonce: string;
  mode?: "sprint"; // a 15-minute sprint (otherwise a classic game)
}

function assertPrizeGame(game: string) {
  if (game !== GAME_PRIZE.game) throw httpError(404, "This game has no leaderboard");
}

/**
 * POST /api/games/:game/start { mode?: "sprint" } — starts a run; returns its run token.
 * Signed-in players' runs are saved to the prize board (`ranked`); anyone's token
 * (uid "anon") proves how long they've played, which unlocks the unreleased track.
 * `signInExpired` tells the game the player's sign-in has run out, so it can say so
 * before they play a game that won't count. A sprint's 15 minutes run from here.
 */
export async function startRun(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const payload: RunToken = {
      uid: req.fan?.id ? String(req.fan.id) : "anon",
      game,
      startedAt: Date.now(),
      nonce: crypto.randomBytes(12).toString("hex"),
      ...(req.body?.mode === "sprint" ? { mode: "sprint" as const } : {}),
    };
    const runToken = jwt.sign(payload, env.jwtSecret, { expiresIn: RUN_TTL_SECONDS });
    const sentSignIn = /^Bearer \S/.test(req.headers.authorization || "");
    res.json({
      runToken,
      ranked: Boolean(req.fan?.id),
      signInExpired: sentSignIn && !req.fan?.id,
      sprintSeconds: payload.mode === "sprint" ? SPRINT_SECONDS : null,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/games/:game/scores { runToken, score, level } — saves a run's progress
 * (checked for plausibility). The game saves at every level, every few seconds of
 * scoring and at game over, so a dropped connection or a closed tab loses little.
 * Saves can arrive late or twice; a run's score only goes up. A run counts for the
 * day it started on: from November 2026 that day's best game adds up into the
 * month's and the week's totals (services/gameScoring); before, the month kept each
 * player's best game. It also counts for any game event it started in (services/events).
 */
export async function submitScore(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const userId = String(req.fan?.id);
    let run: RunToken;
    try {
      run = jwt.verify(String(req.body?.runToken || ""), env.jwtSecret) as RunToken;
    } catch {
      throw httpError(400, "This game is too old to save — start a new one");
    }
    if (run.game !== game) throw httpError(403, "This run is for another game");
    if (run.uid === "anon") throw httpError(403, "This game started before you signed in — start a new game to save your score");
    if (run.uid !== userId) throw httpError(403, "This game was started on another account — start a new game to save your score");

    const score = Math.floor(Number(req.body?.score));
    const level = Math.floor(Number(req.body?.level));
    if (!Number.isFinite(score) || score < 0 || !Number.isFinite(level) || level < 1 || level > 200) {
      throw httpError(400, "Invalid score");
    }
    const seconds = (Date.now() - run.startedAt) / 1000;
    const levelsCleared = level - 1;
    const plausible =
      score <= maxScoreForLevel(level) && levelsCleared * MIN_SECONDS_PER_LEVEL <= seconds && seconds >= 3;
    if (!plausible) throw httpError(422, "That score couldn't be verified");

    // A run counts for the day it started on, and its month's board closes at midnight
    // on the last day — a game still going then can't change a finished month.
    const day = dayOf(new Date(run.startedAt));
    const month = day.slice(0, 7);
    const monthClosed = monthEnd(month).getTime() <= Date.now();

    // The run's progress so far (its first save creates it; a retry may race another save).
    let before = null;
    try {
      before = await GameRun.findOneAndUpdate(
        { nonce: run.nonce },
        { $setOnInsert: { user: userId } },
        { upsert: true, new: false }
      );
    } catch {
      before = await GameRun.findOne({ nonce: run.nonce });
    }
    const now = new Date();
    await GameRun.updateOne({ nonce: run.nonce }, { $max: { score, level }, $set: { savedAt: now } });

    const user = await User.findById(userId);
    if (!user) throw httpError(404, "Account not found");
    const saved = { game, month, score, level, runScore: Math.max(score, before?.score ?? 0), firstSave: !before, now };

    // Events it counts for (services/events) — they have their own windows, even across midnight
    await recordEventGame(
      { id: user._id as Types.ObjectId, name: bidderName(user.name) },
      game,
      { startedAt: run.startedAt, score: saved.runScore, level, firstSave: saved.firstSave },
      now
    ).catch((err) => console.error("[events] couldn't record a game:", err));

    // A sprint's own daily board takes what it scored in its 15 minutes (a minute's grace for the last save).
    const sprint =
      run.mode === "sprint" && seconds <= SPRINT_SECONDS + SPRINT_GRACE_SECONDS ? await saveSprint(user, day, saved) : null;

    if (monthClosed) {
      throw httpError(409, `The ${monthLabel(month)} board closed at midnight — start a new game to play for ${monthLabel(monthOf())}`);
    }
    const boards = isDailyMonth(month) ? await saveDaily(user, day, saved) : await saveBestGame(user, saved);
    res.status(201).json({ ...boards, sprint });
  } catch (err) {
    next(err);
  }
}

// Months and weeks keep the same kind of row; saving and the boards use either.
const MONTHS = GameScore as unknown as Model<IBoardEntry>;
const WEEKS = GameWeek as unknown as Model<IBoardEntry>;
const SPRINTS = GameSprint as unknown as Model<IBoardEntry>;

async function rankOf(M: Model<IBoardEntry>, filter: Record<string, unknown>, score: number, achievedAt: Date) {
  const ahead = await M.countDocuments({ ...filter, $or: [{ score: { $gt: score } }, { score, achievedAt: { $lt: achievedAt } }] });
  return ahead + 1;
}

interface SavedRun {
  game: string;
  month: string;
  score: number; // this save
  level: number;
  runScore: number; // the run's score as the board has it (saves can arrive out of order)
  firstSave: boolean;
  now: Date;
}

/** Months before the daily rules: the month keeps each player's best game; a tie keeps the earlier time. */
async function saveBestGame(user: IUser, { game, month, score, level, runScore, firstSave, now }: SavedRun) {
  await GameScore.updateOne(
    { user: user._id, game, month },
    {
      $setOnInsert: { name: bidderName(user.name), score: 0, level: 1, achievedAt: now },
      ...(firstSave ? { $inc: { runs: 1 } } : {}),
    },
    { upsert: true }
  );
  const improved = await GameScore.findOneAndUpdate(
    { user: user._id, game, month, score: { $lt: score } },
    { $set: { score, level, achievedAt: now, name: bidderName(user.name) } },
    { new: true }
  );
  const best = improved ?? (await GameScore.findOne({ user: user._id, game, month }));
  const [rank, total] = await Promise.all([
    best && !best.disqualified ? rankOf(MONTHS, ranked(game, month), best.score, best.achievedAt) : null,
    GameScore.countDocuments(ranked(game, month)),
  ]);
  return {
    rules: "best" as const,
    saved: runScore,
    newBest: Boolean(improved),
    best: best?.score ?? score,
    rank,
    total,
    month,
  };
}

/**
 * The daily rules: raise the day's best game, then add the days back up into the
 * month's total (its best days) and the week's (all of them). Every total only
 * goes up, so saves racing each other can't lower one.
 */
async function saveDaily(user: IUser, day: string, { game, month, level, runScore, firstSave, now }: SavedRun) {
  const name = bidderName(user.name);
  const week = weekOf(day);
  const dayKey = { game, user: user._id, day };

  // The streak is fixed when the day's first game is saved: one more than yesterday's.
  const [had, yesterday] = await Promise.all([
    GameDay.findOne(dayKey).select("streak best").lean(),
    GameDay.findOne({ ...dayKey, day: addDays(day, -1) }).select("streak").lean(),
  ]);
  const streak = had?.streak ?? (yesterday?.streak ?? 0) + 1;
  await GameDay.updateOne(
    dayKey,
    {
      $setOnInsert: { month, week, streak },
      $set: { name },
      $max: { best: runScore, level, points: dayPoints(runScore, streak) },
      ...(firstSave ? { $inc: { runs: 1 } } : {}),
    },
    { upsert: true }
  );

  // Every day in this month and this week (a week can start in one month and end in the next).
  const monthDays = { from: `${month}-01`, to: `${addDays(`${month}-28`, 7).slice(0, 7)}-01` };
  const weekDays = { from: week, to: addDays(week, 7) };
  const days = await GameDay.find({
    game,
    user: user._id,
    day: { $gte: monthDays.from < weekDays.from ? monthDays.from : weekDays.from, $lt: monthDays.to > weekDays.to ? monthDays.to : weekDays.to },
  }).lean();
  const inMonth = days.filter((d) => d.month === month);
  const thisDay = days.find((d) => d.day === day)!;

  const inWeek = days.filter((d) => d.week === week);
  const [monthRow] = await Promise.all([
    addUp(MONTHS, { game, user: user._id, month }, inMonth, sumPoints(countedDays(inMonth)), name, firstSave, now),
    // A week's board is finished once it's over (a game from late on Sunday stops adding to it).
    hasWeeklyBoard(week) && weekEnd(week).getTime() > now.getTime()
      ? addUp(WEEKS, { game, user: user._id, week }, inWeek, sumPoints(inWeek), name, firstSave, now)
      : null,
  ]);

  const [rank, total] = await Promise.all([
    monthRow && !monthRow.disqualified ? rankOf(MONTHS, ranked(game, month), monthRow.score, monthRow.achievedAt) : null,
    GameScore.countDocuments(ranked(game, month)),
  ]);
  return {
    rules: "daily" as const,
    saved: runScore,
    newBest: runScore > (had?.best ?? 0), // a new best game for the day
    best: thisDay.best, // the day's best game
    rank,
    total,
    month,
    // The day this game counts for (the day it started on) and the month's total
    day: { day, best: thisDay.best, points: thisDay.points, streak: thisDay.streak, bonusPct: bonusPct(thisDay.streak) },
    monthPoints: monthRow?.score ?? 0,
  };
}

/** A sprint game on the daily sprint board: the day keeps each player's best sprint. */
async function saveSprint(user: IUser, day: string, { game, level, runScore, firstSave, now }: SavedRun) {
  const key = { game, user: user._id, day };
  await GameSprint.updateOne(
    key,
    {
      $setOnInsert: { score: 0, achievedAt: now },
      $set: { name: bidderName(user.name) },
      $max: { level, bestRun: runScore },
      ...(firstSave ? { $inc: { runs: 1 } } : {}),
    },
    { upsert: true }
  );
  const improved = await GameSprint.findOneAndUpdate({ ...key, score: { $lt: runScore } }, { $set: { score: runScore, achievedAt: now } }, { new: true });
  const row = improved ?? (await GameSprint.findOne(key));
  const filter = { game, day, score: { $gt: 0 }, disqualified: { $ne: true } };
  const [rank, total] = await Promise.all([
    row && !row.disqualified ? rankOf(SPRINTS, filter, row.score, row.achievedAt) : null,
    GameSprint.countDocuments(filter),
  ]);
  return { day, best: row?.score ?? runScore, newBest: Boolean(improved), rank, total };
}

/** Bring a month's or week's row up to date with its days. Returns the row. */
async function addUp(
  M: Model<IBoardEntry>,
  key: Record<string, unknown>,
  days: Pick<IGameDay, "best" | "level">[],
  total: number,
  name: string,
  firstSave: boolean,
  now: Date
) {
  await M.updateOne(
    key,
    {
      $setOnInsert: { score: 0, achievedAt: now },
      $set: { name },
      $max: {
        bestRun: Math.max(0, ...days.map((d) => d.best)),
        level: Math.max(1, ...days.map((d) => d.level)),
        days: days.length,
      },
      ...(firstSave ? { $inc: { runs: 1 } } : {}),
    },
    { upsert: true }
  );
  // A tie keeps whoever got there first.
  const improved = await M.findOneAndUpdate({ ...key, score: { $lt: total } }, { $set: { score: total, achievedAt: now } }, { new: true });
  return improved ?? (await M.findOne(key));
}

// ---------- Game music: songs from level 4, the unreleased track from level 21 ----------

export const SONGS_FROM_LEVEL = 4;
export const UNRELEASED_FROM_LEVEL = 21;
const UNRELEASED_LINK_TTL = "3h";

/** Playable link for a track (a direct `src` is only used in local testing). */
export const trackSource = (t: IGameTrack, clipSeconds?: number) =>
  t.src || (t.publicId ? gameTrackUrl(t.publicId, clipSeconds) : "");

/** GET /api/games/:game/music — the released songs (signed links) and when each kind kicks in. */
export async function gameMusic(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const tracks = await GameTrack.find({ game, hidden: { $ne: true } }).sort({ order: 1, createdAt: 1 });
    res.json({
      songsFromLevel: SONGS_FROM_LEVEL,
      unreleasedFromLevel: UNRELEASED_FROM_LEVEL,
      songs: tracks
        .filter((t) => t.kind === "song")
        .map((t) => ({ id: String(t._id), title: t.title, artist: t.artist, src: trackSource(t) }))
        .filter((t) => t.src),
      // The unreleased track's title and audio stay hidden until a run earns it.
      hasUnreleased: tracks.some((t) => t.kind === "unreleased"),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/games/:game/unreleased { runToken, level } — a run that has reached
 * level 21 (and has been going long enough to have done it) gets a link to the
 * unreleased track that works for a few hours.
 */
export async function unlockUnreleased(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    let run: RunToken;
    try {
      run = jwt.verify(String(req.body?.runToken || ""), env.jwtSecret) as RunToken;
    } catch {
      throw httpError(400, "This run has expired — start a new game");
    }
    if (run.game !== game) throw httpError(403, "This run is for another game");
    if (run.uid !== "anon" && run.uid !== req.fan?.id) throw httpError(403, "This run belongs to someone else");
    const level = Math.floor(Number(req.body?.level));
    if (!Number.isFinite(level) || level < UNRELEASED_FROM_LEVEL || level > 200) {
      throw httpError(403, `Reach level ${UNRELEASED_FROM_LEVEL} to unlock it`);
    }
    const seconds = (Date.now() - run.startedAt) / 1000;
    if (seconds < (level - 1) * MIN_SECONDS_PER_LEVEL) throw httpError(422, "That run couldn't be verified");

    const track = await GameTrack.findOne({ game, kind: "unreleased", hidden: { $ne: true } });
    if (!track) throw httpError(404, "No unreleased track right now");
    const t = jwt.sign({ kind: "unreleased", game, track: String(track._id) }, env.jwtSecret, {
      expiresIn: UNRELEASED_LINK_TTL,
    });
    res.json({ title: track.title, artist: track.artist, src: `/games/${game}/unreleased/stream?t=${encodeURIComponent(t)}` });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/games/:game/unreleased/stream?t=… — streams the unreleased track
 * through the server, so its storage link never reaches the browser and an
 * unlock link stops working after a few hours. Supports seeking (Range).
 */
export async function streamUnreleased(req: Request, res: Response, next: NextFunction) {
  try {
    let claim: { kind?: string; game?: string; track?: string };
    try {
      claim = jwt.verify(String(req.query.t || ""), env.jwtSecret) as typeof claim;
    } catch {
      throw httpError(401, "This link has expired — reach the level again to unlock it");
    }
    if (claim.kind !== "unreleased" || claim.game !== String(req.params.game) || !Types.ObjectId.isValid(String(claim.track))) {
      throw httpError(401, "Invalid link");
    }
    const track = await GameTrack.findById(claim.track);
    if (!track || track.kind !== "unreleased") throw httpError(404, "Track not found");

    const range = req.headers.range;
    const upstream = await fetch(trackSource(track), { headers: range ? { Range: String(range) } : {} });
    if (!upstream.ok) throw httpError(502, "Couldn't load the track");
    res.status(upstream.status);
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", "inline");
    if (!upstream.body) {
      res.end();
      return;
    }
    const body = Readable.fromWeb(upstream.body as unknown as NodeReadableStream);
    req.on("close", () => body.destroy());
    body.on("error", () => res.end());
    body.pipe(res);
  } catch (err) {
    next(err);
  }
}

/**
 * A page of a board (names shortened, with each player's flair — rank, badges, name
 * colour), how many are on it, the leader and — for a signed-in fan — their rank with
 * the players just above and below them.
 */
export async function readBoard(
  M: Model<IBoardEntry>,
  key: Record<string, unknown>,
  { offset, limit, userId }: { offset: number; limit: number; userId?: string }
) {
  const filter = { ...key, score: { $gt: 0 }, disqualified: { $ne: true } };
  const [page, total, mine] = await Promise.all([
    M.find(filter).sort(BOARD_ORDER).skip(offset).limit(limit),
    M.countDocuments(filter),
    userId ? M.findOne({ ...key, user: userId, score: { $gt: 0 } }) : null,
  ]);
  const leader = offset === 0 ? page[0] : await M.findOne(filter).sort(BOARD_ORDER);
  // Two players above and two below the signed-in fan, so everyone sees where they stand.
  const myRank = mine && !mine.disqualified ? await rankOf(M, filter, mine.score, mine.achievedAt) : null;
  const from = myRank ? Math.max(0, myRank - 3) : 0;
  const near = myRank ? await M.find(filter).sort(BOARD_ORDER).skip(from).limit(myRank - from + 2) : [];

  const flair = await flairFor([...page, ...near, ...(leader ? [leader] : [])].map((s) => s.user));
  const row = (s: IBoardEntry, rank: number) => ({
    rank,
    name: s.name,
    score: s.score,
    level: s.level,
    days: s.days ?? null,
    bestRun: s.bestRun ?? null,
    flair: flair.get(String(s.user)) ?? null,
    mine: Boolean(userId && String(s.user) === userId),
  });

  let me = null;
  if (mine) {
    const mineView = { score: mine.score, level: mine.level, days: mine.days ?? null, bestRun: mine.bestRun ?? null };
    me = myRank
      ? { ...mineView, rank: myRank, disqualified: false, around: near.map((s, i) => row(s, from + i + 1)) }
      : { ...mineView, rank: null, disqualified: true, around: [] };
  }
  return { total, offset, leader: leader ? row(leader, 1) : null, top: page.map((s, i) => row(s, offset + i + 1)), me };
}

/**
 * The signed-in fan's day so far: their best game and points today and their streak.
 * Not played yet today: the streak they'd carry on, and the bonus today's game would get.
 */
async function todayFor(game: string, userId: string) {
  const day = dayOf();
  const [today, yesterday] = await Promise.all([
    GameDay.findOne({ game, user: userId, day }).lean(),
    GameDay.findOne({ game, user: userId, day: addDays(day, -1) }).select("streak").lean(),
  ]);
  if (today) return { played: true, best: today.best, points: today.points, streak: today.streak, bonusPct: bonusPct(today.streak) };
  const streak = yesterday?.streak ?? 0;
  return { played: false, best: 0, points: 0, streak, bonusPct: bonusPct(streak + 1) };
}

export const pageOf = (req: Request) => ({
  limit: Math.min(100, Math.max(1, Math.floor(Number(req.query.limit)) || 20)),
  offset: Math.max(0, Math.floor(Number(req.query.offset)) || 0),
});

/**
 * GET /api/games/:game/leaderboard?month=YYYY-MM&offset=0&limit=20 — the month's prize board
 * GET /api/games/:game/leaderboard?week=YYYY-MM-DD — the week (Monday–Sunday) with that day in it
 * A page of the board, the leader, the prize (what's deposited in the pool — months
 * only), the rules it's scored by and, for a signed-in fan, where they stand and
 * their streak today.
 */
export async function leaderboard(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const userId = req.fan?.id;
    const now = Date.now();

    if (req.query.sprint !== undefined) {
      // A day's sprint board: everyone's best 15-minute sprint that day
      const day = isDay(req.query.sprint) ? String(req.query.sprint) : dayOf();
      const endsAt = new Date(`${addDays(day, 1)}T00:00:00Z`);
      const board = await readBoard(SPRINTS, { game, day }, { ...pageOf(req), userId });
      return res.json({
        game,
        period: "sprint",
        day,
        month: day.slice(0, 7),
        rules: "best",
        scoring: null,
        sprintMinutes: SPRINT_SECONDS / 60,
        prizeGhs: 0,
        funded: false,
        startsAt: new Date(`${day}T00:00:00Z`),
        endsAt,
        ended: endsAt.getTime() <= now,
        ...board,
        prize: null,
        today: null,
      });
    }

    if (req.query.week !== undefined) {
      const week = weekOf(isDay(req.query.week) ? String(req.query.week) : dayOf());
      const ended = weekEnd(week).getTime() <= now;
      const board = hasWeeklyBoard(week)
        ? await readBoard(WEEKS, { game, week }, { ...pageOf(req), userId })
        : { total: 0, offset: 0, leader: null, top: [], me: null };
      return res.json({
        game,
        period: "week",
        week,
        month: week.slice(0, 7),
        rules: "daily",
        scoring: SCORING,
        prizeGhs: 0,
        funded: false,
        startsAt: weekStart(week),
        endsAt: weekEnd(week),
        ended,
        ...board,
        prize: null,
        today: userId && !ended ? await todayFor(game, userId) : null,
      });
    }

    const month = parseMonth(req.query.month);
    const ended = monthEnd(month).getTime() <= now;
    if (ended && month === prevMonth()) await settlePrize(game, month).catch(() => {});
    const daily = isDailyMonth(month);
    const [board, pool, prize, today] = await Promise.all([
      readBoard(MONTHS, { game, month }, { ...pageOf(req), userId }),
      poolFor(game, month),
      ended ? WalletTxn.findOne({ kind: "prize", game, month, active: true }) : null,
      userId && daily && !ended ? todayFor(game, userId) : null,
    ]);
    res.json({
      game,
      period: "month",
      month,
      // "daily": the month's best days add up (November 2026 on) · "best": the best single game
      rules: daily ? "daily" : "best",
      scoring: daily ? SCORING : null,
      // The prize is what DMY has deposited into the pool (the announced amount until then).
      prizeGhs: prize?.amountGhs ?? pool.prizeGhs,
      funded: pool.funded,
      startsAt: new Date(`${month}-01T00:00:00Z`),
      endsAt: monthEnd(month),
      ended,
      ...board,
      prize: prize ? { amountGhs: prize.amountGhs, inReview: prize.status === "review", availableAt: prize.availableAt ?? null } : null,
      today,
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/games/:game/leaderboard?month= — the board with contact details, and the month's winner. */
export async function adminLeaderboard(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const month = parseMonth(req.query.month);
    if (month === prevMonth()) await settlePrize(game, month).catch(() => {});
    const [rows, prize, pool] = await Promise.all([
      GameScore.find({ game, month, score: { $gt: 0 } })
        .sort(BOARD_ORDER)
        .limit(100)
        .populate<{ user: { _id: Types.ObjectId; name?: string; email: string; phone?: string } }>("user", "name email phone"),
      WalletTxn.findOne({ kind: "prize", game, month, active: true }),
      poolFor(game, month),
    ]);
    let rank = 0; // disqualified scores don't take a place
    res.json({
      game,
      month,
      rules: isDailyMonth(month) ? "daily" : "best",
      scoring: isDailyMonth(month) ? SCORING : null,
      prizeGhs: prize?.amountGhs ?? pool.prizeGhs,
      depositedGhs: pool.depositedGhs,
      funded: pool.funded,
      endsAt: monthEnd(month),
      ended: monthEnd(month).getTime() <= Date.now(),
      winner: prize
        ? { userId: String(prize.user), amountGhs: prize.amountGhs, status: prize.status, availableAt: prize.availableAt ?? null }
        : null,
      top: rows.map((s) => ({
        rank: s.disqualified ? null : ++rank,
        disqualified: Boolean(s.disqualified),
        // populated("user") still holds the id when the account no longer exists
        userId: String(s.user?._id ?? s.populated("user") ?? ""),
        name: s.user?.name ?? s.name,
        email: s.user?.email ?? null,
        phone: s.user?.phone ?? null,
        score: s.score,
        level: s.level,
        days: s.days ?? null,
        bestRun: s.bestRun ?? null,
        runs: s.runs,
        achievedAt: s.achievedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/games/:game/days?month=&userId= — a player's days that month (for the
 * score check): each day's best game, streak and points, and which days count.
 */
export async function adminPlayerDays(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const month = parseMonth(req.query.month);
    const userId = String(req.query.userId || "");
    if (!Types.ObjectId.isValid(userId)) throw httpError(400, "Choose a player");
    const days = await GameDay.find({ game, user: userId, month }).sort({ day: 1 }).lean();
    const counted = new Set(countedDays(days).map((d) => d.day));
    res.json({
      month,
      bestDays: SCORING.bestDays,
      days: days.map((d) => ({
        day: d.day,
        best: d.best,
        level: d.level,
        streak: d.streak,
        bonusPct: bonusPct(d.streak),
        points: d.points,
        runs: d.runs,
        counts: counted.has(d.day),
      })),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/games/:game/disqualify { month, userId, disqualified } — remove a score
 * from the board (or put it back), along with the player's weeks and sprints in that month. If that
 * changes who's on top of a finished month, the prize moves from the old winner's
 * wallet to the new winner's (who is emailed) — unless it has already been withdrawn.
 */
export async function setDisqualified(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const month = String(req.body?.month || "");
    const userId = String(req.body?.userId || "");
    if (!/^\d{4}-\d{2}$/.test(month) || !Types.ObjectId.isValid(userId)) throw httpError(400, "Choose a month and player");
    const disqualified = req.body?.disqualified === true || req.body?.disqualified === "true";

    const before = await GameScore.findOne({ game, month, user: userId });
    if (!before) throw httpError(404, "No score for that player this month");
    await GameScore.updateOne({ _id: before._id }, { $set: { disqualified } });

    const r = await reassessWinner(game, month);
    if (!r.ok) {
      // Can't move a prize that's already been withdrawn — undo.
      await GameScore.updateOne({ _id: before._id }, { $set: { disqualified: before.disqualified } });
      throw httpError(409, r.message ?? "Couldn't change the winner");
    }
    await GameWeek.updateMany({ game, user: userId, week: { $in: weeksTouching(month) } }, { $set: { disqualified } });
    await GameSprint.updateMany({ game, user: userId, day: { $gte: `${month}-01`, $lte: `${month}-31` } }, { $set: { disqualified } });
    forgetWins(); // their badges
    res.json({ ok: true, disqualified });
  } catch (err) {
    next(err);
  }
}