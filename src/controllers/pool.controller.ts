import { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import { PoolMatch, type IPoolMatch } from "../models/PoolMatch";
import { User } from "../models/User";
import { clientIp } from "../utils/clientIp";
import { flairFor } from "../services/flair";
import {
  TURN_SECONDS,
  RANKED_BEST_OF,
  START_RATING,
  ratingOf,
  applyTimeouts,
  takeShot,
  concede,
  createChallenge,
  acceptChallenge,
  joinQueue,
  checkQueue,
  leaveQueue,
  lookingNow,
} from "../services/pool";
import { poolNightWindow, poolNightSlug } from "../services/poolNight";
import { GameEvent, GameEventEntry } from "../models/GameEvent";
import { bidderName } from "./auction.controller";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const CHALLENGE_TTL_MS = 30 * 60e3;

async function player(req: Request) {
  const u = await User.findById(req.fan?.id).select("name poolRating");
  if (!u) throw httpError(404, "Account not found");
  return { user: u._id as Types.ObjectId, userId: String(u._id), name: bidderName(u.name), rating: ratingOf(u), ip: clientIp(req) };
}

/** A match the fan is in right now (playing, or their challenge waiting for a friend). */
async function activeMatch(userId: string) {
  const m = await PoolMatch.findOne({ "players.user": userId, status: { $in: ["waiting", "playing"] } }).sort({ createdAt: -1 });
  if (m?.status === "waiting" && Date.now() - m.createdAt.getTime() > CHALLENGE_TTL_MS) {
    await PoolMatch.updateOne({ _id: m._id, status: "waiting" }, { $set: { status: "cancelled" } });
    return null;
  }
  return m;
}

/**
 * The two players' record against each other, all time — every finished match between
 * them, ranked or friendly. Kept briefly (pages check a match every second or two), and
 * worked out again once a match between them finishes.
 */
const h2hCache = new Map<string, { at: number; wins: Map<string, number>; frames: Map<string, number>; matches: number; since: Date | null }>();
async function headToHead(m: IPoolMatch) {
  if (m.players.length < 2) return null;
  const [a, b] = m.players.map((p) => String(p.user));
  const key = [a, b].sort().join(":");
  let hit = h2hCache.get(key);
  const stale = !hit || Date.now() - hit.at > 60_000 || (m.finishedAt && m.finishedAt.getTime() > hit.at);
  if (stale) {
    const games = await PoolMatch.find({ status: "finished", "players.user": { $all: [new Types.ObjectId(a), new Types.ObjectId(b)] } })
      .select("players.user winner frames finishedAt")
      .lean();
    const wins = new Map<string, number>();
    const frames = new Map<string, number>();
    let since: Date | null = null;
    for (const g of games) {
      g.players.forEach((p, i) => frames.set(String(p.user), (frames.get(String(p.user)) ?? 0) + (g.frames?.[i] ?? 0)));
      if (g.winner !== null && g.winner !== undefined) {
        const w = String(g.players[g.winner]?.user);
        wins.set(w, (wins.get(w) ?? 0) + 1);
      }
      if (g.finishedAt && (!since || g.finishedAt < since)) since = g.finishedAt;
    }
    hit = { at: Date.now(), wins, frames, matches: games.length, since };
    if (h2hCache.size > 500) h2hCache.clear();
    h2hCache.set(key, hit);
  }
  return {
    wins: m.players.map((p) => hit!.wins.get(String(p.user)) ?? 0), // in the players' order
    frames: m.players.map((p) => hit!.frames.get(String(p.user)) ?? 0),
    matches: hit!.matches,
    since: hit!.since,
  };
}

/** A match as a player (or a watcher) sees it. */
async function matchView(m: IPoolMatch, viewerId?: string) {
  const [flair, h2h] = await Promise.all([flairFor(m.players.map((p) => p.user)), headToHead(m)]);
  const me = viewerId ? m.players.findIndex((p) => String(p.user) === viewerId) : -1;
  return {
    headToHead: h2h, // their record against each other, all time
    code: m.code,
    ranked: m.ranked,
    bestOf: m.bestOf,
    status: m.status,
    players: m.players.map((p) => ({ name: p.name, rating: p.rating, flair: flair.get(String(p.user)) ?? null })),
    me: me === -1 ? null : me,
    frames: m.frames,
    frameNo: m.frameNo,
    frame: m.frame,
    shotNo: m.shotNo,
    lastShot: m.lastShot,
    turnEndsAt: m.turnEndsAt,
    turnSeconds: TURN_SECONDS,
    now: new Date(), // the server's clock, for the turn timer
    winner: m.winner,
    reason: m.reason ?? null,
    ratingChange: m.ratingChange ?? null,
    expiresAt: m.status === "waiting" ? new Date(m.createdAt.getTime() + CHALLENGE_TTL_MS) : null,
  };
}

const findMatch = async (code: unknown) => {
  const m = await PoolMatch.findOne({ code: String(code || "").toUpperCase() });
  if (!m) throw httpError(404, "That match doesn't exist");
  return m;
};

/** GET /api/pool/me — your rating, record, ladder place, the match you're in and the queue. */
export async function poolMe(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan?.id);
    const [u, active, queue] = await Promise.all([
      User.findById(userId).select("poolRating poolWins poolLosses").lean(),
      activeMatch(userId),
      checkQueue(userId),
    ]);
    const rated = u?.poolRating !== undefined;
    const rank = rated ? (await User.countDocuments({ poolRating: { $gt: u!.poolRating } })) + 1 : null;
    res.json({
      rating: u?.poolRating ?? START_RATING,
      wins: u?.poolWins ?? 0,
      losses: u?.poolLosses ?? 0,
      rank,
      active: active ? { code: active.code, status: active.status, ranked: active.ranked } : null,
      queue,
    });
  } catch (err) {
    next(err);
  }
}

/** POST /api/pool/queue — look for a ranked match (best of 3). Already in one: here it is. */
export async function poolJoinQueue(req: Request, res: Response, next: NextFunction) {
  try {
    const p = await player(req);
    const active = await activeMatch(p.userId);
    if (active?.status === "playing") return res.json({ status: "matched", code: active.code });
    res.json(await joinQueue(p));
  } catch (err) {
    next(err);
  }
}

/** GET /api/pool/queue — still looking, or matched (with the match code). */
export async function poolCheckQueue(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await checkQueue(String(req.fan?.id)));
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/pool/queue — stop looking. */
export async function poolLeaveQueue(req: Request, res: Response, next: NextFunction) {
  try {
    leaveQueue(String(req.fan?.id));
    res.json({ status: "idle" });
  } catch (err) {
    next(err);
  }
}

/** POST /api/pool/challenges { bestOf } — a match against a friend (unranked), started by sending them the link. */
export async function poolChallenge(req: Request, res: Response, next: NextFunction) {
  try {
    const p = await player(req);
    const bestOf = [1, 3, 5].includes(Number(req.body?.bestOf)) ? (Number(req.body.bestOf) as 1 | 3 | 5) : RANKED_BEST_OF;
    const active = await activeMatch(p.userId);
    if (active?.status === "playing") throw httpError(409, "Finish (or give up) your match first");
    // A new challenge replaces one still waiting
    await PoolMatch.updateMany({ "players.user": p.user, status: "waiting" }, { $set: { status: "cancelled" } });
    leaveQueue(p.userId);
    const m = await createChallenge(p, bestOf);
    res.status(201).json(await matchView(m, p.userId));
  } catch (err) {
    next(err);
  }
}

/** GET /api/pool/matches/:code — the table (the page checks every second or two). */
export async function poolMatch(req: Request, res: Response, next: NextFunction) {
  try {
    let m = await findMatch(req.params.code);
    if (m.status === "waiting" && Date.now() - m.createdAt.getTime() > CHALLENGE_TTL_MS) {
      await PoolMatch.updateOne({ _id: m._id, status: "waiting" }, { $set: { status: "cancelled" } });
      m = await findMatch(req.params.code);
    }
    res.json(await matchView(await applyTimeouts(m), req.fan?.id));
  } catch (err) {
    next(err);
  }
}

/** POST /api/pool/matches/:code/accept — take a friend's challenge. */
export async function poolAccept(req: Request, res: Response, next: NextFunction) {
  try {
    const p = await player(req);
    const active = await activeMatch(p.userId);
    if (active?.status === "playing" && active.code !== String(req.params.code).toUpperCase()) {
      throw httpError(409, "Finish (or give up) your other match first");
    }
    leaveQueue(p.userId);
    const m = await acceptChallenge(String(req.params.code).toUpperCase(), p);
    res.json(await matchView(m, p.userId));
  } catch (err) {
    next(err);
  }
}

/** POST /api/pool/matches/:code/shot { shotNo, dx, dy, power, cue? } */
export async function poolShot(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan?.id);
    const m = await findMatch(req.params.code);
    const b = req.body ?? {};
    const cue = b.cue && typeof b.cue === "object" ? { x: Number(b.cue.x), y: Number(b.cue.y) } : undefined;
    const saved = await takeShot(m, userId, {
      shotNo: Number(b.shotNo),
      shot: { dx: Number(b.dx), dy: Number(b.dy), power: Number(b.power) },
      cue,
    });
    res.json(await matchView(saved, userId));
  } catch (err) {
    next(err);
  }
}

/** POST /api/pool/matches/:code/concede — give up (or call off your waiting challenge). */
export async function poolConcede(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan?.id);
    const m = await findMatch(req.params.code);
    if (!m.players.some((p) => String(p.user) === userId)) throw httpError(403, "You're not in this match");
    res.json(await matchView(await concede(m, userId), userId));
  } catch (err) {
    next(err);
  }
}

/** GET /api/pool/ladder — the ranked ladder (top 50), and where you stand. */
export async function poolLadder(req: Request, res: Response, next: NextFunction) {
  try {
    const top = await User.find({ poolRating: { $exists: true } }).sort({ poolRating: -1, _id: 1 }).limit(50).select("name poolRating poolWins poolLosses").lean();
    const flair = await flairFor(top.map((u) => u._id));
    const userId = req.fan?.id;
    const total = await User.countDocuments({ poolRating: { $exists: true } });
    let me = null;
    if (userId) {
      const u = await User.findById(userId).select("poolRating poolWins poolLosses").lean();
      if (u?.poolRating !== undefined) {
        me = { rank: (await User.countDocuments({ poolRating: { $gt: u.poolRating } })) + 1, rating: u.poolRating, wins: u.poolWins ?? 0, losses: u.poolLosses ?? 0 };
      }
    }
    res.json({
      total,
      top: top.map((u, i) => ({
        rank: i + 1,
        name: bidderName(u.name),
        rating: u.poolRating,
        wins: u.poolWins ?? 0,
        losses: u.poolLosses ?? 0,
        flair: flair.get(String(u._id)) ?? null,
        mine: Boolean(userId && String(u._id) === userId),
      })),
      me,
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/pool/night — DMY Pool Night: tonight's or the next one, and how busy the tables are. */
export async function poolNight(_req: Request, res: Response, next: NextFunction) {
  try {
    const now = Date.now();
    const { startsAt, endsAt } = poolNightWindow(now);
    const ev = await GameEvent.findOne({ slug: poolNightSlug(startsAt) }).select("slug cancelled prizeGhs").lean();
    const [playing, players] = await Promise.all([
      // Matches someone is still playing (an abandoned one's clock ran out minutes ago)
      PoolMatch.countDocuments({ status: "playing", turnEndsAt: { $gt: new Date(now - 2 * 60e3) } }),
      ev ? GameEventEntry.countDocuments({ event: ev._id }) : 0,
    ]);
    res.json({
      startsAt,
      endsAt,
      status: ev?.cancelled ? "cancelled" : startsAt.getTime() <= now ? "live" : "upcoming",
      slug: ev?.slug ?? null, // the night's event page (its board)
      prizeGhs: ev?.prizeGhs ?? 0,
      looking: lookingNow(), // in the ranked queue right now
      playing, // matches being played right now
      players, // have played a ranked match tonight
      now: new Date(),
    });
  } catch (err) {
    next(err);
  }
}

// ---------- Admin ----------

/** GET /api/admin/pool/matches — recent ranked matches, flagging players on the same network (could be one person). */
export async function adminPoolMatches(_req: Request, res: Response, next: NextFunction) {
  try {
    const matches = await PoolMatch.find({ ranked: true, status: "finished" })
      .sort({ finishedAt: -1 })
      .limit(100)
      .populate<{ players: { user: { _id: Types.ObjectId; name?: string; email: string } | null; name: string; rating: number; ip?: string; timeouts: number }[] }>("players.user", "name email");
    res.json(
      matches.map((m) => ({
        code: m.code,
        finishedAt: m.finishedAt,
        frames: m.frames,
        winner: m.winner,
        reason: m.reason ?? null,
        ratingChange: m.ratingChange ?? null,
        sameNetwork: Boolean(m.players[0]?.ip && m.players[0].ip === m.players[1]?.ip),
        players: m.players.map((p) => ({ name: p.user?.name ?? p.name, email: p.user?.email ?? null, rating: p.rating })),
      }))
    );
  } catch (err) {
    next(err);
  }
}
