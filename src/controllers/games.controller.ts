import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { Readable } from "stream";
import type { ReadableStream as NodeReadableStream } from "stream/web";
import jwt from "jsonwebtoken";
import { Schema, model, Types } from "mongoose";
import { env } from "../config/env";
import { GameTrack, type IGameTrack } from "../models/GameTrack";
import { gameTrackUrl } from "../services/cloudinary";
import { GameScore, GamePrize, MOMO_NETWORKS, prizeStatus, type IGamePrize, type MomoNetwork } from "../models/GameScore";
import { User } from "../models/User";
import { sendMail, sendNotification } from "../services/mailer";
import { renderEmail, renderText, type EmailContent } from "../services/emailTemplates";
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
/** The month before this one — the latest whose prize can be settled. */
const prevMonth = (d = new Date()) => monthOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)));
const monthEnd = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)); // first instant of the next month
};
const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const parseMonth = (v: unknown) => (/^\d{4}-\d{2}$/.test(String(v || "")) ? String(v) : monthOf());
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const ghs = (n: number) => `GH₵${n.toLocaleString("en-US")}`;

/** Scores that count on the board: played this month and not disqualified. */
const ranked = (game: string, month: string) => ({ game, month, score: { $gt: 0 }, disqualified: { $ne: true } });
const BOARD_ORDER = { score: -1, achievedAt: 1 } as const; // a tie goes to whoever got there first

async function email(to: string | null | undefined, c: EmailContent) {
  if (to) await sendMail(to, c.title, renderText(c), renderEmail(c)).catch(() => {});
}

/** "0241234567" → "024 •••• 567" */
const maskMomo = (n?: string) => (n ? `${n.slice(0, 3)} •••• ${n.slice(-3)}` : "");

/** Accepts 024 123 4567, +233 24 123 4567, 233241234567 … → "0241234567", or null. */
function normalizeMomo(v: unknown): string | null {
  let d = String(v ?? "").replace(/\D/g, "");
  if (d.startsWith("233") && d.length === 12) d = `0${d.slice(3)}`;
  else if (d.length === 9) d = `0${d}`;
  return /^0[25]\d{8}$/.test(d) ? d : null;
}

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

/**
 * POST /api/games/:game/start — starts a run; returns a single-use run token.
 * Signed-in players' tokens can be submitted to the prize board; anyone's token
 * (uid "anon") proves how long they've played, which unlocks the unreleased track.
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
    ...ranked(game, month),
    $or: [{ score: { $gt: score } }, { score, achievedAt: { $lt: achievedAt } }],
  });
  return ahead + 1;
}

/**
 * Once a month is over, its prize goes to the top score that wasn't disqualified,
 * and the winner is emailed to withdraw it. Safe to call again — it only acts once.
 */
export async function settlePrize(game: string, month: string): Promise<void> {
  if (monthEnd(month).getTime() > Date.now()) return;
  if (await GamePrize.exists({ game, month })) return;
  const winner = await GameScore.findOne(ranked(game, month)).sort(BOARD_ORDER);
  if (!winner) return;
  try {
    const r = await GamePrize.updateOne(
      { game, month },
      { $setOnInsert: { user: winner.user, amountGhs: GAME_PRIZE.prizeGhs, status: "won", notifiedAt: new Date() } },
      { upsert: true }
    );
    if (!r.upsertedCount) return;
  } catch {
    return; // settled at the same moment elsewhere (unique index)
  }
  const user = await User.findById(winner.user);
  const label = monthLabel(month);
  void email(user?.email, {
    title: `You won ${ghs(GAME_PRIZE.prizeGhs)}! 🏆`,
    intro:
      `You finished ${label} with the top Beat Breaker score (${winner.score.toLocaleString("en-US")}). ` +
      `Withdraw your ${ghs(GAME_PRIZE.prizeGhs)} to Mobile Money from your DMY account — we check the top scores, then pay within 7 days.`,
    button: { label: "Withdraw my prize", url: `${env.clientUrl}/account#prize` },
  });
  void sendNotification(
    `🏆 Beat Breaker winner — ${label}`,
    `${user?.name || winner.name} (${user?.email ?? "unknown"}) won ${ghs(GAME_PRIZE.prizeGhs)} with ${winner.score} points (level ${winner.level}, ${winner.runs} runs).\n` +
      `They've been emailed to withdraw it. You'll get another email when they give their Mobile Money number. Check the scores in admin → Game Prize.`
  ).catch(() => {});
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

/** Run by the server every minute: settles last month's prize as soon as the month ends. */
export const sweepGamePrizes = () => settlePrize(GAME_PRIZE.game, prevMonth());

/**
 * GET /api/games/:game/leaderboard?month=YYYY-MM&offset=0&limit=20
 * A page of the board (names shortened), how many are playing, the leader, and —
 * for a signed-in fan — their rank with the players just above and below them.
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

    const [page, total, prize] = await Promise.all([
      GameScore.find(filter).sort(BOARD_ORDER).skip(offset).limit(limit),
      GameScore.countDocuments(filter),
      ended ? GamePrize.findOne({ game, month }) : null,
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
      prizeGhs: GAME_PRIZE.prizeGhs,
      endsAt: monthEnd(month),
      ended,
      total,
      offset,
      leader: leader ? row(leader, 1) : null,
      top: page.map((s, i) => row(s, offset + i + 1)),
      me,
      prize: prize ? { status: prizeStatus(prize) } : null,
    });
  } catch (err) {
    next(err);
  }
}

/** What a fan sees about their own prize (the number is masked). */
const myPrizeView = (p: IGamePrize) => ({
  month: p.month,
  amountGhs: p.amountGhs,
  status: prizeStatus(p),
  requestedAt: p.requestedAt ?? null,
  paidAt: p.paidAt ?? null,
  momo: p.momoNumber ? { network: p.momoNetwork ?? null, number: maskMomo(p.momoNumber), accountName: p.accountName ?? null } : null,
});

/** GET /api/games/:game/prizes/mine — the signed-in fan's prizes (won, withdrawal requested, paid). */
export async function myPrizes(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    await settlePrize(game, prevMonth()).catch(() => {});
    const list = await GamePrize.find({ game, user: req.fan?.id }).sort({ month: -1 }).limit(24);
    res.json(list.map(myPrizeView));
  } catch (err) {
    next(err);
  }
}

/** POST /api/games/:game/prizes/:month/withdraw { network, number, accountName } — the winner asks to be paid. */
export async function withdrawPrize(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const month = String(req.params.month);
    if (!/^\d{4}-\d{2}$/.test(month)) throw httpError(400, "Unknown month");
    const network = String(req.body?.network || "") as MomoNetwork;
    if (!MOMO_NETWORKS.includes(network)) throw httpError(400, "Choose your Mobile Money network");
    const number = normalizeMomo(req.body?.number);
    if (!number) throw httpError(400, "Enter a valid Ghana Mobile Money number, e.g. 024 123 4567");
    const accountName = String(req.body?.accountName || "").trim().replace(/\s+/g, " ").slice(0, 80);
    if (accountName.length < 3) throw httpError(400, "Enter the name on the Mobile Money account");

    // Details can be corrected until DMY has paid.
    const prize = await GamePrize.findOneAndUpdate(
      { game, month, user: req.fan?.id, status: { $in: ["won", "requested"] } },
      { $set: { status: "requested", momoNetwork: network, momoNumber: number, accountName, requestedAt: new Date() } },
      { new: true }
    );
    if (!prize) {
      const existing = await GamePrize.findOne({ game, month, user: req.fan?.id });
      throw existing
        ? httpError(409, "This prize has already been paid")
        : httpError(404, "There's no prize to withdraw for that month");
    }

    const user = await User.findById(req.fan?.id);
    const label = monthLabel(month);
    void sendNotification(
      `💸 Prize withdrawal — ${label} · ${ghs(prize.amountGhs)}`,
      `${user?.name || "The winner"} (${user?.email ?? "unknown"}) wants their Beat Breaker prize.\n\n` +
        `Mobile Money: ${network} ${number}\nAccount name: ${accountName}\nAmount: ${ghs(prize.amountGhs)}\n\n` +
        `Check the scores in admin → Game Prize, send the money, then click "Mark paid".`
    ).catch(() => {});
    void email(user?.email, {
      title: "We've got your withdrawal request",
      intro:
        `We'll send your ${ghs(prize.amountGhs)} Beat Breaker prize (${label}) to ${network} Mobile Money ${maskMomo(number)} ` +
        `(${accountName}) within 7 days, after checking the top scores. We'll email you as soon as it's sent.`,
      button: { label: "See your account", url: `${env.clientUrl}/account#prize` },
    });
    res.json(myPrizeView(prize));
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/games/:game/leaderboard?month= — full details for paying the winner. */
export async function adminLeaderboard(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const month = parseMonth(req.query.month);
    if (month === prevMonth()) await settlePrize(game, month).catch(() => {});
    const rows = await GameScore.find({ game, month, score: { $gt: 0 } })
      .sort(BOARD_ORDER)
      .limit(100)
      .populate<{ user: { _id: Types.ObjectId; name?: string; email: string; phone?: string } }>("user", "name email phone");
    const prize = await GamePrize.findOne({ game, month });
    let rank = 0; // disqualified scores don't take a place
    res.json({
      game,
      month,
      prizeGhs: GAME_PRIZE.prizeGhs,
      endsAt: monthEnd(month),
      ended: monthEnd(month).getTime() <= Date.now(),
      prize: prize
        ? {
            status: prizeStatus(prize),
            userId: String(prize.user),
            amountGhs: prize.amountGhs,
            momoNetwork: prize.momoNetwork ?? null,
            momoNumber: prize.momoNumber ?? null,
            accountName: prize.accountName ?? null,
            requestedAt: prize.requestedAt ?? null,
            paidAt: prize.paidAt ?? null,
            note: prize.note ?? null,
          }
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

/** POST /api/admin/games/:game/prize { month, userId, note } — record that the prize was paid (emails the winner). */
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
          status: "paid",
          paidAt: new Date(),
          note: typeof req.body?.note === "string" ? req.body.note.slice(0, 300) : undefined,
        },
      },
      { upsert: true, new: true }
    );
    const user = await User.findById(userId);
    void email(user?.email, {
      title: `Your ${ghs(prize.amountGhs)} has been sent 🎉`,
      intro: prize.momoNumber
        ? `We've sent your Beat Breaker prize for ${monthLabel(month)} to ${prize.momoNetwork} Mobile Money ${maskMomo(prize.momoNumber)}. Congratulations — see you on the board this month!`
        : `We've paid your Beat Breaker prize for ${monthLabel(month)}. Congratulations — see you on the board this month!`,
    });
    res.json({ ok: true, paidAt: prize.paidAt });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/games/:game/disqualify { month, userId, disqualified } — remove a score
 * from the board (or put it back). If that changes who's on top of a finished month,
 * an unpaid prize moves to the new winner, who is emailed.
 */
export async function setDisqualified(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const month = String(req.body?.month || "");
    const userId = String(req.body?.userId || "");
    if (!/^\d{4}-\d{2}$/.test(month) || !Types.ObjectId.isValid(userId)) throw httpError(400, "Choose a month and player");
    const disqualified = req.body?.disqualified === true || req.body?.disqualified === "true";
    const prize = await GamePrize.findOne({ game, month });
    if (prize && prizeStatus(prize) === "paid") throw httpError(400, "This month's prize has already been paid");

    const score = await GameScore.findOneAndUpdate({ game, month, user: userId }, { $set: { disqualified } }, { new: true });
    if (!score) throw httpError(404, "No score for that player this month");

    if (prize) {
      const top = await GameScore.findOne(ranked(game, month)).sort(BOARD_ORDER);
      if (!top || String(top.user) !== String(prize.user)) {
        await GamePrize.deleteOne({ _id: prize._id, status: { $ne: "paid" } });
        await settlePrize(game, month);
      }
    }
    res.json({ ok: true, disqualified });
  } catch (err) {
    next(err);
  }
}
