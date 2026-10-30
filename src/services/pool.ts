import crypto from "crypto";
import { Types } from "mongoose";
import { PoolMatch, type IPoolMatch, type PoolShotRecord } from "../models/PoolMatch";
import { User } from "../models/User";
import { newFrame, simulate, judge, timeOut, canPlaceCue, STEP, type Frame, type Shot } from "../pool/engine";
import { dayOf } from "./gameScoring";
import { recordEventMatch } from "./events";
import { isPoolNight } from "./poolNight";

/*
 * DMY Pool matches, start to finish (the table and the rules are in pool/engine):
 *  - Ranked matches (best of 3) come from the matchmaking queue — random opponents
 *    near your rating, so friends can't feed each other wins. The same two players
 *    count for the ladder at most SAME_PAIR_PER_DAY times a day. Win = climb, lose = drop.
 *  - Friend challenges (best of 1, 3 or 5) start from an invite link and don't move ratings.
 *  - Every shot is played out here; pages only send where they aimed, how hard, and
 *    (with ball in hand) where they put the cue ball.
 *  - TURN_SECONDS a shot. Running out of time passes the turn with ball in hand;
 *    TIMEOUTS_TO_LOSE in a row loses the match.
 */

export const GAME = "pool";
export const TURN_SECONDS = 40;
const TIMEOUTS_TO_LOSE = 3;
export const START_RATING = 1000;
const K = 32;
const SAME_PAIR_PER_DAY = 3;
export const RANKED_BEST_OF = 3;
const CHALLENGE_TTL_MS = 30 * 60e3;

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const newCode = () => crypto.randomBytes(5).toString("hex").toUpperCase().slice(0, 8);
/** A random order for the rack's other balls. */
function shuffledRack() {
  const ids = [2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15];
  for (let i = ids.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return [...ids, 1, 9, 8];
}
/** The next shooter's clock — it starts once the shot that's just been played has finished rolling on their screen. */
const deadline = (playMs = 0) => new Date(Date.now() + playMs + TURN_SECONDS * 1000);
export const ratingOf = (u: { poolRating?: number }) => u.poolRating ?? START_RATING;

interface Player {
  user: Types.ObjectId;
  name: string;
  rating: number;
  ip?: string;
}

/** Begin play: the first frame, broken by a random player. */
function startPlay(m: IPoolMatch) {
  const breaker = crypto.randomInt(2) as 0 | 1;
  m.status = "playing";
  m.breaker = breaker;
  m.frame = newFrame(shuffledRack(), breaker);
  m.frameNo = 1;
  m.frames = [0, 0];
  m.turnEndsAt = deadline();
  m.startedAt = new Date();
}

export async function createMatch(a: Player, b: Player, ranked: boolean, bestOf: 1 | 3 | 5) {
  const m = new PoolMatch({ code: newCode(), ranked, bestOf, players: [a, b].map((p) => ({ ...p, timeouts: 0 })) });
  startPlay(m);
  await m.save();
  return m;
}

/** A friend challenge: open until someone accepts it with the link. */
export async function createChallenge(a: Player, bestOf: 1 | 3 | 5) {
  return PoolMatch.create({ code: newCode(), ranked: false, bestOf, players: [{ ...a, timeouts: 0 }], status: "waiting" });
}

export async function acceptChallenge(code: string, b: Player) {
  const m = await PoolMatch.findOne({ code });
  if (!m) throw httpError(404, "That challenge doesn't exist");
  if (m.status !== "waiting") {
    if (m.players.some((p) => String(p.user) === String(b.user))) return m;
    throw httpError(409, "Someone already took that challenge");
  }
  if (Date.now() - m.createdAt.getTime() > CHALLENGE_TTL_MS) throw httpError(410, "That challenge has expired — ask for a new link");
  if (String(m.players[0].user) === String(b.user)) throw httpError(409, "That's your own challenge — send the link to a friend");
  m.players.push({ ...b, timeouts: 0 });
  startPlay(m);
  // Only if nobody accepted at the same moment
  const done = await PoolMatch.findOneAndUpdate(
    { _id: m._id, status: "waiting" },
    {
      $set: {
        players: m.players,
        status: m.status,
        breaker: m.breaker,
        frame: m.frame,
        frameNo: m.frameNo,
        frames: m.frames,
        turnEndsAt: m.turnEndsAt,
        startedAt: m.startedAt,
      },
    },
    { new: true }
  );
  if (!done) throw httpError(409, "Someone already took that challenge");
  return done;
}

// ---------- Playing ----------

/** Save a change to the match if nobody else changed it first (the shot number guards it). */
async function commit(m: IPoolMatch, prevShotNo: number) {
  const saved = await PoolMatch.findOneAndUpdate(
    { _id: m._id, shotNo: prevShotNo },
    {
      $set: {
        frame: m.frame,
        frames: m.frames,
        frameNo: m.frameNo,
        breaker: m.breaker,
        players: m.players,
        shotNo: m.shotNo,
        lastShot: m.lastShot,
        turnEndsAt: m.turnEndsAt,
        status: m.status,
        winner: m.winner,
        reason: m.reason,
        ratingChange: m.ratingChange,
        finishedAt: m.finishedAt,
      },
    },
    { new: true }
  );
  return saved;
}

/** The match is over: ratings move (ranked), and ranked wins count for Pool events. */
async function finish(m: IPoolMatch, winner: 0 | 1, reason: string) {
  m.status = "finished";
  m.winner = winner;
  m.reason = reason;
  m.finishedAt = new Date();
  m.turnEndsAt = null;
  if (!m.ranked) return;
  const w = m.players[winner];
  const l = m.players[winner === 0 ? 1 : 0];
  const expected = 1 / (1 + Math.pow(10, (l.rating - w.rating) / 400));
  const delta = Math.max(1, Math.round(K * (1 - expected)));
  m.ratingChange = winner === 0 ? [delta, -delta] : [-delta, delta];
}

/** After a finished match is saved: apply the ratings and record it for events (once — the save is guarded). */
async function afterFinish(m: IPoolMatch) {
  if (!m.ranked || m.status !== "finished" || m.winner === null) return;
  const winner = m.winner;
  const change = m.ratingChange ?? [0, 0];
  await Promise.all(
    m.players.map((p, i) =>
      User.updateOne({ _id: p.user }, [
        {
          $set: {
            poolRating: { $max: [100, { $add: [{ $ifNull: ["$poolRating", START_RATING] }, change[i]] }] },
            poolWins: { $add: [{ $ifNull: ["$poolWins", 0] }, i === winner ? 1 : 0] },
            poolLosses: { $add: [{ $ifNull: ["$poolLosses", 0] }, i === winner ? 0 : 1] },
          },
        },
      ])
    )
  );
  const startedAt = (m.startedAt ?? m.createdAt).getTime();
  for (const [i, p] of m.players.entries()) {
    await recordEventMatch({ id: p.user, name: p.name }, GAME, { startedAt, won: i === winner }, m.finishedAt ?? new Date()).catch((err) =>
      console.error("[pool] couldn't record an event match:", err)
    );
  }
}

/**
 * Turns that ran out while nobody was looking: each passes the turn with ball in hand,
 * and too many in a row loses the match. Run before showing or changing a match.
 */
export async function applyTimeouts(m: IPoolMatch): Promise<IPoolMatch> {
  let cur = m;
  for (let guard = 0; guard < 10; guard++) {
    if (cur.status !== "playing" || !cur.frame || !cur.turnEndsAt || cur.turnEndsAt.getTime() > Date.now()) return cur;
    const prev = cur.shotNo;
    const by = cur.frame.turn;
    cur.players[by].timeouts += 1;
    cur.shotNo += 1;
    const ended = cur.turnEndsAt.getTime();
    if (cur.players[by].timeouts >= TIMEOUTS_TO_LOSE) {
      cur.lastShot = { no: cur.shotNo, by, frameNo: cur.frameNo, timeout: true };
      await finish(cur, by === 0 ? 1 : 0, `${cur.players[by].name} ran out of time ${TIMEOUTS_TO_LOSE} turns in a row`);
    } else {
      cur.frame = timeOut(cur.frame);
      cur.lastShot = { no: cur.shotNo, by, frameNo: cur.frameNo, timeout: true };
      cur.turnEndsAt = new Date(ended + TURN_SECONDS * 1000); // the next turn's clock started when this one ran out
    }
    const saved = await commit(cur, prev);
    if (!saved) {
      // Someone else got there first — carry on from what they saved
      const fresh = await PoolMatch.findById(cur._id);
      if (!fresh) return cur;
      cur = fresh;
      continue;
    }
    if (saved.status === "finished") await afterFinish(saved);
    cur = saved;
  }
  return cur;
}

/** The shooter's shot: placed cue ball (if in hand), aim and power. Played out here. */
export async function takeShot(
  match: IPoolMatch,
  userId: string,
  input: { shotNo: number; shot: Shot; cue?: { x: number; y: number } }
): Promise<IPoolMatch> {
  const m = await applyTimeouts(match);
  if (m.status !== "playing" || !m.frame) throw httpError(409, "This match isn't being played");
  const me = m.players.findIndex((p) => String(p.user) === userId) as 0 | 1 | -1;
  if (me === -1) throw httpError(403, "You're not in this match");
  if (m.frame.turn !== me) throw httpError(409, "It's not your turn");
  if (input.shotNo !== m.shotNo) throw httpError(409, "The table has changed — have another look");
  const { dx, dy, power } = input.shot;
  if (![dx, dy, power].every(Number.isFinite) || (dx === 0 && dy === 0) || power <= 0 || power > 1) throw httpError(400, "Aim and pick a power");

  // Ball in hand: put the cue ball where they chose (checked)
  const before: Frame = { ...m.frame, balls: m.frame.balls.map((b) => ({ ...b })) };
  if (before.ballInHand) {
    const c = input.cue;
    const behindLine = before.breakShot || before.kitchen === true;
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y) || !canPlaceCue(before.balls, c.x, c.y, behindLine)) {
      throw httpError(
        400,
        before.breakShot ? "Place the cue ball behind the line to break" : behindLine ? "Place the cue ball behind the line" : "Place the cue ball somewhere free on the table"
      );
    }
    const cue = before.balls.find((b) => b.id === 0)!;
    cue.x = c.x;
    cue.y = c.y;
    cue.potted = false;
  }

  const sim = simulate(before.balls, input.shot);
  const { frame, outcome } = judge(before, sim);
  const playMs = Math.round(sim.steps * STEP * 1000); // pages animate it in real time
  const prev = m.shotNo;
  m.shotNo += 1;
  m.players[me].timeouts = 0; // they're here
  m.lastShot = {
    no: m.shotNo,
    by: me,
    frameNo: m.frameNo,
    shot: { dx, dy, power },
    ...(before.ballInHand ? { cue: { x: input.cue!.x, y: input.cue!.y } } : {}),
    start: before.balls,
    outcome,
  } satisfies PoolShotRecord;

  if (outcome.frameWinner !== null) {
    const w = outcome.frameWinner;
    m.frames = [m.frames[0] + (w === 0 ? 1 : 0), m.frames[1] + (w === 1 ? 1 : 0)];
    if (m.frames[w] > m.bestOf / 2) {
      m.frame = frame;
      await finish(m, w, `${m.players[w].name} won ${m.frames[w]}–${m.frames[w === 0 ? 1 : 0]}`);
    } else {
      // Next frame: the other player breaks
      m.breaker = m.breaker === 0 ? 1 : 0;
      m.frameNo += 1;
      m.frame = newFrame(shuffledRack(), m.breaker);
      m.turnEndsAt = deadline(playMs);
    }
  } else {
    m.frame = frame;
    m.turnEndsAt = deadline(playMs);
  }
  const saved = await commit(m, prev);
  if (!saved) throw httpError(409, "The table has changed — have another look");
  if (saved.status === "finished") await afterFinish(saved);
  return saved;
}

/** Give up: the opponent wins. */
export async function concede(match: IPoolMatch, userId: string) {
  const m = await applyTimeouts(match);
  if (m.status === "waiting") {
    await PoolMatch.updateOne({ _id: m._id, status: "waiting" }, { $set: { status: "cancelled" } });
    return (await PoolMatch.findById(m._id))!;
  }
  if (m.status !== "playing") return m;
  const me = m.players.findIndex((p) => String(p.user) === userId);
  if (me === -1) throw httpError(403, "You're not in this match");
  const prev = m.shotNo;
  m.shotNo += 1;
  await finish(m, me === 0 ? 1 : 0, `${m.players[me].name} gave up`);
  const saved = await commit(m, prev);
  if (!saved) throw httpError(409, "The table has changed — try again");
  await afterFinish(saved);
  return saved;
}

// ---------- Matchmaking (ranked) ----------

interface Waiting {
  userId: string;
  name: string;
  rating: number;
  ip?: string;
  since: number;
  seen: number;
  matched?: string; // the match code, once paired
}
const queue = new Map<string, Waiting>();
const SEEN_TTL = 15_000; // dropped if their page stops checking in
let pairing: Promise<void> | null = null;

/** How many ranked matches these two have played today. */
const pairedToday = (a: string, b: string) =>
  PoolMatch.countDocuments({ ranked: true, "players.user": { $all: [new Types.ObjectId(a), new Types.ObjectId(b)] }, createdAt: { $gte: new Date(`${dayOf()}T00:00:00Z`) } });

/**
 * Pair whoever's waiting: closest rating first, the range widening the longer they wait —
 * and wider from the start on Pool Night, so everyone who turns up gets games.
 */
async function pairUp() {
  const now = Date.now();
  for (const [id, w] of queue) if (now - w.seen > SEEN_TTL || (w.matched && now - w.seen > 60_000)) queue.delete(id);
  const waiting = [...queue.values()].filter((w) => !w.matched).sort((a, b) => a.since - b.since);
  const startRange = isPoolNight(now) ? 400 : 150;
  for (const a of waiting) {
    if (a.matched) continue;
    const range = startRange + ((now - a.since) / 1000) * 10;
    const options = waiting
      .filter((b) => b !== a && !b.matched && Math.abs(b.rating - a.rating) <= range)
      .sort((x, y) => Math.abs(x.rating - a.rating) - Math.abs(y.rating - a.rating));
    for (const b of options) {
      if ((await pairedToday(a.userId, b.userId)) >= SAME_PAIR_PER_DAY) continue;
      const m = await createMatch(
        { user: new Types.ObjectId(a.userId), name: a.name, rating: a.rating, ip: a.ip },
        { user: new Types.ObjectId(b.userId), name: b.name, rating: b.rating, ip: b.ip },
        true,
        RANKED_BEST_OF
      );
      a.matched = b.matched = m.code;
      break;
    }
  }
}
/** One pairing at a time (two pages checking in together mustn't pair the same player twice). */
async function pair() {
  while (pairing) await pairing;
  pairing = pairUp().finally(() => (pairing = null));
  await pairing;
}

export async function joinQueue(p: { userId: string; name: string; rating: number; ip?: string }) {
  const had = queue.get(p.userId);
  queue.set(p.userId, had && !had.matched ? { ...had, seen: Date.now() } : { ...p, since: Date.now(), seen: Date.now() });
  await pair();
  return queueState(p.userId);
}

export async function checkQueue(userId: string) {
  const w = queue.get(userId);
  if (!w) return { status: "idle" as const, waiting: queue.size };
  w.seen = Date.now();
  await pair();
  return queueState(userId);
}

function queueState(userId: string) {
  const w = queue.get(userId);
  if (!w) return { status: "idle" as const, waiting: queue.size };
  if (w.matched) return { status: "matched" as const, code: w.matched };
  return { status: "searching" as const, since: new Date(w.since), waiting: [...queue.values()].filter((x) => !x.matched).length };
}

export const leaveQueue = (userId: string) => queue.delete(userId);

/** How many are looking for a ranked match right now (still checking in). */
export function lookingNow() {
  const now = Date.now();
  return [...queue.values()].filter((w) => !w.matched && now - w.seen <= SEEN_TTL).length;
}
