import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { Readable } from "stream";
import type { ReadableStream as NodeReadableStream } from "stream/web";
import jwt from "jsonwebtoken";
import { Schema, model, Types } from "mongoose";
import { env } from "../config/env";
import { GameTrack, type IGameTrack } from "../models/GameTrack";
import { gameTrackUrl } from "../services/cloudinary";
import { GameScore } from "../models/GameScore";
import { User } from "../models/User";
import { WalletTxn } from "../models/Wallet";
import { bidderName } from "./auction.controller";
import {
  GAME_PRIZE,
  BOARD_ORDER,
  ranked,
  monthOf,
  prevMonth,
  monthEnd,
  poolFor,
  settlePrize,
  reassessWinner,
} from "../services/prizes";

export { GAME_PRIZE };

// Beat Breaker scoring limits (mirror of the game): 8 bricks per row, rows = min(4 + level, 9),
// a brick is worth at most 50 (gold) × 2 (on the beat), and clearing level L adds 100 × L.
const BRICKS_PER_ROW = 8;
const MAX_POINTS_PER_BRICK = 100;
const MIN_SECONDS_PER_LEVEL = 12; // nobody clears a wall faster than this
const RUN_TTL_SECONDS = 12 * 3600; // the best players' runs last hours

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
}

function assertPrizeGame(game: string) {
  if (game !== GAME_PRIZE.game) throw httpError(404, "This game has no leaderboard");
}

/**
 * POST /api/games/:game/start — starts a run; returns its run token.
 * Signed-in players' runs are saved to the prize board (`ranked`); anyone's token
 * (uid "anon") proves how long they've played, which unlocks the unreleased track.
 * `signInExpired` tells the game the player's sign-in has run out, so it can say so
 * before they play a game that won't count.
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
    };
    const runToken = jwt.sign(payload, env.jwtSecret, { expiresIn: RUN_TTL_SECONDS });
    const sentSignIn = /^Bearer \S/.test(req.headers.authorization || "");
    res.json({ runToken, ranked: Boolean(req.fan?.id), signInExpired: sentSignIn && !req.fan?.id });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/games/:game/scores { runToken, score, level } — saves a run's progress
 * (checked for plausibility). The game saves at every level, every few seconds of
 * scoring and at game over, so a dropped connection or a closed tab loses little.
 * Saves can arrive late or twice; a run's score only goes up, and the month keeps
 * each player's best.
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
    const month = monthOf();

    // Keep only the month's best; a tie keeps the earlier time.
    await GameScore.updateOne(
      { user: user._id, game, month },
      {
        $setOnInsert: { name: bidderName(user.name), score: 0, level: 1, achievedAt: now },
        ...(before ? {} : { $inc: { runs: 1 } }),
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
      best && !best.disqualified ? rankOf(game, month, best.score, best.achievedAt) : null,
      GameScore.countDocuments(ranked(game, month)),
    ]);
    res.status(201).json({
      saved: Math.max(score, before?.score ?? 0), // this run's score as the board has it
      newBest: Boolean(improved),
      best: best?.score ?? score,
      rank,
      total,
      month,
    });
  } catch (err) {
    next(err);
  }
}

async function rankOf(game: string, month: string, score: number, achievedAt: Date) {
  const ahead = await GameScore.countDocuments({
    ...ranked(game, month),
    $or: [{ score: { $gt: score } }, { score, achievedAt: { $lt: achievedAt } }],
  });
  return ahead + 1;
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
 * GET /api/games/:game/leaderboard?month=YYYY-MM&offset=0&limit=20
 * A page of the board (names shortened), how many are playing, the leader, the
 * prize (what's deposited in the pool) and — for a signed-in fan — their rank
 * with the players just above and below them.
 */
export async function leaderboard(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const month = parseMonth(req.query.month);
    const limit = Math.min(100, Math.max(1, Math.floor(Number(req.query.limit)) || 20));
    const offset = Math.max(0, Math.floor(Number(req.query.offset)) || 0);
    const filter = ranked(game, month);
    const ended = monthEnd(month).getTime() <= Date.now();
    if (ended && month === prevMonth()) await settlePrize(game, month).catch(() => {});

    const [page, total, pool, prize] = await Promise.all([
      GameScore.find(filter).sort(BOARD_ORDER).skip(offset).limit(limit),
      GameScore.countDocuments(filter),
      poolFor(game, month),
      ended ? WalletTxn.findOne({ kind: "prize", game, month, active: true }) : null,
    ]);
    const leader = offset === 0 ? page[0] : await GameScore.findOne(filter).sort(BOARD_ORDER);

    const userId = req.fan?.id;
    const row = (s: (typeof page)[number], rank: number) => ({
      rank,
      name: s.name,
      score: s.score,
      level: s.level,
      mine: Boolean(userId && String(s.user) === userId),
    });

    let me = null;
    if (userId) {
      const mine = await GameScore.findOne({ game, month, user: userId, score: { $gt: 0 } });
      if (mine?.disqualified) {
        me = { rank: null, score: mine.score, level: mine.level, disqualified: true, around: [] };
      } else if (mine) {
        const rank = await rankOf(game, month, mine.score, mine.achievedAt);
        // Two players above and two below, so everyone sees where they stand.
        const from = Math.max(0, rank - 3);
        const near = await GameScore.find(filter).sort(BOARD_ORDER).skip(from).limit(rank - from + 2);
        me = {
          rank,
          score: mine.score,
          level: mine.level,
          disqualified: false,
          around: near.map((s, i) => row(s, from + i + 1)),
        };
      }
    }

    res.json({
      game,
      month,
      // The prize is what DMY has deposited into the pool (the announced amount until then).
      prizeGhs: prize?.amountGhs ?? pool.prizeGhs,
      funded: pool.funded,
      endsAt: monthEnd(month),
      ended,
      total,
      offset,
      leader: leader ? row(leader, 1) : null,
      top: page.map((s, i) => row(s, offset + i + 1)),
      me,
      prize: prize ? { amountGhs: prize.amountGhs, inReview: prize.status === "review", availableAt: prize.availableAt ?? null } : null,
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
        runs: s.runs,
        achievedAt: s.achievedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/games/:game/disqualify { month, userId, disqualified } — remove a score
 * from the board (or put it back). If that changes who's on top of a finished month,
 * the prize moves from the old winner's wallet to the new winner's (who is emailed) —
 * unless it has already been withdrawn.
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
    res.json({ ok: true, disqualified });
  } catch (err) {
    next(err);
  }
}