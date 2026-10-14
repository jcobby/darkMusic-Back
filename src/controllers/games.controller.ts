import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Schema, model, Types } from "mongoose";
import { env } from "../config/env";
import { GameScore, GamePrize } from "../models/GameScore";
import { User } from "../models/User";
import { bidderName } from "./auction.controller";

/** The monthly prize: only Beat Breaker counts. */
export const GAME_PRIZE = { game: "beat-breaker", prizeGhs: 500 } as const;

// Beat Breaker scoring limits (mirror of the game): 8 bricks per row, rows = min(4 + level, 9),
// a brick is worth at most 50 (gold) × 2 (on the beat), and clearing level L adds 100 × L.
const BRICKS_PER_ROW = 8;
const MAX_POINTS_PER_BRICK = 100;
const MIN_SECONDS_PER_LEVEL = 12; // nobody clears a wall faster than this
const RUN_TTL_SECONDS = 3 * 3600;

/** Highest score a run could possibly reach by the end of `level`. */
export function maxScoreForLevel(level: number): number {
  let total = 0;
  for (let l = 1; l <= level; l++) {
    const rows = Math.min(4 + l, 9);
    total += rows * BRICKS_PER_ROW * MAX_POINTS_PER_BRICK + 100 * l;
  }
  return total;
}

const monthOf = (d = new Date()) => d.toISOString().slice(0, 7);
const monthEnd = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)); // first instant of the next month
};
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

// Each run token can be submitted once (kept for a day, then expires).
const usedRunSchema = new Schema({
  nonce: { type: String, required: true, unique: true },
  user: { type: Schema.Types.ObjectId, required: true },
  createdAt: { type: Date, default: Date.now, expires: 86400 },
});
const UsedRun = model("UsedGameRun", usedRunSchema);

interface RunToken {
  uid: string;
  game: string;
  startedAt: number;
  nonce: string;
}

function assertPrizeGame(game: string) {
  if (game !== GAME_PRIZE.game) throw httpError(404, "This game has no leaderboard");
}

/** POST /api/games/:game/start — a signed-in fan starts a run; returns a single-use run token. */
export async function startRun(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const payload: RunToken = {
      uid: String(req.fan?.id),
      game,
      startedAt: Date.now(),
      nonce: crypto.randomBytes(12).toString("hex"),
    };
    const runToken = jwt.sign(payload, env.jwtSecret, { expiresIn: RUN_TTL_SECONDS });
    res.json({ runToken });
  } catch (err) {
    next(err);
  }
}

/** POST /api/games/:game/scores — submit a finished run's score (checked for plausibility). */
export async function submitScore(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const userId = String(req.fan?.id);
    let run: RunToken;
    try {
      run = jwt.verify(String(req.body?.runToken || ""), env.jwtSecret) as RunToken;
    } catch {
      throw httpError(400, "This run has expired — start a new game to submit a score");
    }
    if (run.uid !== userId || run.game !== game) throw httpError(403, "This run belongs to someone else");

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

    try {
      await UsedRun.create({ nonce: run.nonce, user: userId });
    } catch {
      throw httpError(409, "This run was already submitted");
    }

    const user = await User.findById(userId);
    if (!user) throw httpError(404, "Account not found");
    const month = monthOf();
    const now = new Date();

    // Keep only the month's best; a tie keeps the earlier time.
    await GameScore.updateOne(
      { user: user._id, game, month },
      { $setOnInsert: { name: bidderName(user.name), score: 0, level: 1, achievedAt: now }, $inc: { runs: 1 } },
      { upsert: true }
    );
    const improved = await GameScore.findOneAndUpdate(
      { user: user._id, game, month, score: { $lt: score } },
      { $set: { score, level, achievedAt: now, name: bidderName(user.name) } },
      { new: true }
    );
    const best = improved ?? (await GameScore.findOne({ user: user._id, game, month }));
    const rank = best ? await rankOf(game, month, best.score, best.achievedAt) : null;
    res.status(201).json({ newBest: Boolean(improved), best: best?.score ?? score, rank, month });
  } catch (err) {
    next(err);
  }
}

async function rankOf(game: string, month: string, score: number, achievedAt: Date) {
  const ahead = await GameScore.countDocuments({
    game,
    month,
    score: { $gt: 0 },
    $or: [{ score: { $gt: score } }, { score, achievedAt: { $lt: achievedAt } }],
  });
  return ahead + 1;
}

/** GET /api/games/:game/leaderboard?month=YYYY-MM — top scores (names shortened), plus your own rank. */
export async function leaderboard(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : monthOf();
    const top = await GameScore.find({ game, month, score: { $gt: 0 } })
      .sort({ score: -1, achievedAt: 1 })
      .limit(20);
    const userId = req.fan?.id;
    let me = null;
    if (userId) {
      const mine = await GameScore.findOne({ game, month, user: userId, score: { $gt: 0 } });
      if (mine) me = { rank: await rankOf(game, month, mine.score, mine.achievedAt), score: mine.score, level: mine.level };
    }
    res.json({
      game,
      month,
      prizeGhs: GAME_PRIZE.prizeGhs,
      endsAt: monthEnd(month),
      top: top.map((s, i) => ({
        rank: i + 1,
        name: s.name,
        score: s.score,
        level: s.level,
        mine: Boolean(userId && String(s.user) === userId),
      })),
      me,
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/games/:game/leaderboard?month= — full details for paying the winner. */
export async function adminLeaderboard(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : monthOf();
    const top = await GameScore.find({ game, month, score: { $gt: 0 } })
      .sort({ score: -1, achievedAt: 1 })
      .limit(50)
      .populate<{ user: { _id: Types.ObjectId; name?: string; email: string; phone?: string } }>("user", "name email phone");
    const prize = await GamePrize.findOne({ game, month });
    res.json({
      game,
      month,
      prizeGhs: GAME_PRIZE.prizeGhs,
      endsAt: monthEnd(month),
      ended: monthEnd(month).getTime() <= Date.now(),
      paid: prize ? { userId: String(prize.user), paidAt: prize.paidAt, note: prize.note ?? null } : null,
      top: top.map((s, i) => ({
        rank: i + 1,
        userId: String(s.user?._id ?? ""),
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

/** POST /api/admin/games/:game/prize { month, userId, note } — record that the prize was paid. */
export async function recordPrize(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const month = String(req.body?.month || "");
    const userId = String(req.body?.userId || "");
    if (!/^\d{4}-\d{2}$/.test(month) || !Types.ObjectId.isValid(userId)) throw httpError(400, "Choose a month and winner");
    if (monthEnd(month).getTime() > Date.now()) throw httpError(400, "That month hasn't finished yet");
    const prize = await GamePrize.findOneAndUpdate(
      { game, month },
      {
        $set: {
          user: userId,
          amountGhs: GAME_PRIZE.prizeGhs,
          paidAt: new Date(),
          note: typeof req.body?.note === "string" ? req.body.note.slice(0, 300) : undefined,
        },
      },
      { upsert: true, new: true }
    );
    res.json({ ok: true, paidAt: prize.paidAt });
  } catch (err) {
    next(err);
  }
}
