import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { Types } from "mongoose";
import { Squad, SQUAD_MIN, SQUAD_MAX, SQUAD_COOLDOWN_DAYS, type ISquad } from "../models/Squad";
import { GameScore } from "../models/GameScore";
import { User } from "../models/User";
import { GAME_PRIZE, isMonth, monthOf, monthEnd } from "../services/prizes";
import { bidderName } from "./auction.controller";

/*
 * Squads: 3–5 fans whose Beat Breaker month totals add up on the squad board —
 * bragging rights, and the squad's tag next to every member's name. Join with an
 * invite code; the captain (who made it) can remove members. Leaving means waiting
 * SQUAD_COOLDOWN_DAYS before joining another, so nobody hops to the top squad at
 * the end of the month.
 */

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const isDuplicate = (err: unknown) => (err as { code?: number })?.code === 11000;
const newCode = () => crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
const NAME_RX = /^[\p{L}\p{N}][\p{L}\p{N} '\-]{1,22}[\p{L}\p{N}]$/u;
const TAG_RX = /^[A-Z0-9]{2,5}$/;

/** Each squad's month total: its members' Beat Breaker month scores added up. */
async function squadTotals(squads: ISquad[], month: string) {
  const ids = squads.flatMap((s) => s.members.map((m) => m.user));
  const scores = await GameScore.find({ game: GAME_PRIZE.game, month, user: { $in: ids }, disqualified: { $ne: true } })
    .select("user score")
    .lean();
  const byUser = new Map(scores.map((s) => [String(s.user), s.score]));
  return { byUser, total: (s: ISquad) => s.members.reduce((sum, m) => sum + (byUser.get(String(m.user)) ?? 0), 0) };
}

/** The squad board for a month: squads with enough members, biggest total first. */
async function squadBoard(month: string) {
  const squads = await Squad.find({ [`members.${SQUAD_MIN - 1}`]: { $exists: true } });
  const { total } = await squadTotals(squads, month);
  return squads
    .map((s) => ({ squad: s, score: total(s) }))
    .sort((a, b) => b.score - a.score || a.squad.createdAt.getTime() - b.squad.createdAt.getTime())
    .map((x, i) => ({ rank: i + 1, id: String(x.squad._id), name: x.squad.name, tag: x.squad.tag, members: x.squad.members.length, score: x.score }));
}

async function mySquadView(userId: string, month: string) {
  const squad = await Squad.findOne({ "members.user": userId });
  if (!squad) return null;
  const [users, { byUser, total }] = await Promise.all([
    User.find({ _id: { $in: squad.members.map((m) => m.user) } }).select("name").lean(),
    squadTotals([squad], month),
  ]);
  const nameOf = new Map(users.map((u) => [String(u._id), bidderName(u.name)]));
  return {
    id: String(squad._id),
    name: squad.name,
    tag: squad.tag,
    code: squad.code,
    captain: String(squad.captain) === userId,
    score: total(squad),
    ranked: squad.members.length >= SQUAD_MIN,
    members: squad.members
      .map((m) => ({
        userId: String(m.user),
        name: nameOf.get(String(m.user)) ?? "Fan",
        captain: String(m.user) === String(squad.captain),
        me: String(m.user) === userId,
        score: byUser.get(String(m.user)) ?? 0,
      }))
      .sort((a, b) => b.score - a.score),
  };
}

/** GET /api/squads?month=YYYY-MM — the squad board, and (signed in) your squad. */
export async function listSquads(req: Request, res: Response, next: NextFunction) {
  try {
    const month = isMonth(req.query.month) ? String(req.query.month) : monthOf();
    const userId = req.fan?.id;
    const [board, mine, me] = await Promise.all([
      squadBoard(month),
      userId ? mySquadView(userId, month) : null,
      userId ? User.findById(userId).select("squadFreeAt").lean() : null,
    ]);
    res.json({
      month,
      endsAt: monthEnd(month),
      ended: monthEnd(month).getTime() <= Date.now(),
      min: SQUAD_MIN,
      max: SQUAD_MAX,
      board,
      mine,
      // Left a squad recently: when they can join another
      freeAt: me?.squadFreeAt && me.squadFreeAt.getTime() > Date.now() ? me.squadFreeAt : null,
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/squads/invite/:code — the squad an invite is for (to show before joining). */
export async function squadInvite(req: Request, res: Response, next: NextFunction) {
  try {
    const squad = await Squad.findOne({ code: String(req.params.code || "").toUpperCase() });
    if (!squad) throw httpError(404, "That invite code doesn't match a squad");
    res.json({ name: squad.name, tag: squad.tag, members: squad.members.length, full: squad.members.length >= SQUAD_MAX });
  } catch (err) {
    next(err);
  }
}

async function freeToJoin(userId: string) {
  if (await Squad.exists({ "members.user": userId })) throw httpError(409, "You're already in a squad — leave it first");
  const me = await User.findById(userId).select("squadFreeAt");
  if (me?.squadFreeAt && me.squadFreeAt.getTime() > Date.now()) {
    throw httpError(409, `You left a squad recently — you can join another from ${me.squadFreeAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}`);
  }
}

/** POST /api/squads { name, tag } — start a squad (you're its captain). */
export async function createSquad(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan?.id);
    const name = String(req.body?.name ?? "").trim().replace(/\s+/g, " ");
    const tag = String(req.body?.tag ?? "").trim().toUpperCase();
    if (!NAME_RX.test(name)) throw httpError(400, "Squad names are 3–24 letters, numbers and spaces");
    if (!TAG_RX.test(tag)) throw httpError(400, "The tag is 2–5 letters or numbers, e.g. LAW");
    await freeToJoin(userId);
    for (let i = 0; i < 3; i++) {
      try {
        await Squad.create({ name, nameKey: name.toLowerCase(), tag, code: newCode(), captain: userId, members: [{ user: userId, joinedAt: new Date() }] });
        break;
      } catch (err) {
        if (!isDuplicate(err)) throw err;
        const msg = String((err as Error).message);
        if (/nameKey/.test(msg)) throw httpError(409, "That squad name is taken");
        if (/tag/.test(msg)) throw httpError(409, "That tag is taken");
        if (/members\.user/.test(msg)) throw httpError(409, "You're already in a squad");
        // the invite code clashed — try another
      }
    }
    res.status(201).json(await mySquadView(userId, monthOf()));
  } catch (err) {
    next(err);
  }
}

/** POST /api/squads/join { code } */
export async function joinSquad(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan?.id);
    const code = String(req.body?.code ?? "").trim().toUpperCase();
    await freeToJoin(userId);
    let joined;
    try {
      // Only while there's room (checked in the same update, so two can't take the last place)
      joined = await Squad.findOneAndUpdate(
        { code, [`members.${SQUAD_MAX - 1}`]: { $exists: false } },
        { $push: { members: { user: new Types.ObjectId(userId), joinedAt: new Date() } } },
        { new: true }
      );
    } catch (err) {
      if (isDuplicate(err)) throw httpError(409, "You're already in a squad");
      throw err;
    }
    if (!joined) {
      if (await Squad.exists({ code })) throw httpError(409, `That squad is full (${SQUAD_MAX} members)`);
      throw httpError(404, "That invite code doesn't match a squad");
    }
    res.json(await mySquadView(userId, monthOf()));
  } catch (err) {
    next(err);
  }
}

/** Take a member out; the next to have joined becomes captain, and an empty squad is closed. */
async function removeMember(squad: ISquad, userId: string) {
  const left = squad.members.filter((m) => String(m.user) !== userId);
  if (!left.length) {
    await Squad.deleteOne({ _id: squad._id });
    return;
  }
  const captain = String(squad.captain) === userId ? [...left].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())[0].user : squad.captain;
  await Squad.updateOne({ _id: squad._id }, { $pull: { members: { user: new Types.ObjectId(userId) } }, $set: { captain } });
}

/** POST /api/squads/leave */
export async function leaveSquad(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan?.id);
    const squad = await Squad.findOne({ "members.user": userId });
    if (!squad) throw httpError(404, "You're not in a squad");
    await removeMember(squad, userId);
    await User.updateOne({ _id: userId }, { $set: { squadFreeAt: new Date(Date.now() + SQUAD_COOLDOWN_DAYS * 86400e3) } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** POST /api/squads/remove { userId } — the captain takes a member out (they can join another squad straight away). */
export async function removeFromSquad(req: Request, res: Response, next: NextFunction) {
  try {
    const me = String(req.fan?.id);
    const target = String(req.body?.userId ?? "");
    const squad = await Squad.findOne({ "members.user": me });
    if (!squad) throw httpError(404, "You're not in a squad");
    if (String(squad.captain) !== me) throw httpError(403, "Only the captain can remove members");
    if (target === me) throw httpError(400, "Leave the squad instead");
    if (!squad.members.some((m) => String(m.user) === target)) throw httpError(404, "They're not in your squad");
    await removeMember(squad, target);
    res.json(await mySquadView(me, monthOf()));
  } catch (err) {
    next(err);
  }
}

// ---------- Admin ----------

/** GET /api/admin/squads — every squad with its members (to moderate names). */
export async function adminListSquads(_req: Request, res: Response, next: NextFunction) {
  try {
    const squads = await Squad.find()
      .sort({ createdAt: -1 })
      .limit(200)
      .populate<{ members: { user: { _id: Types.ObjectId; name?: string; email: string } | null; joinedAt: Date }[] }>("members.user", "name email");
    const month = monthOf();
    const scores = await GameScore.find({ game: GAME_PRIZE.game, month, user: { $in: squads.flatMap((s) => s.members.map((m) => m.user?._id)) } })
      .select("user score")
      .lean();
    const byUser = new Map(scores.map((s) => [String(s.user), s.score]));
    res.json(
      squads.map((s) => ({
        id: String(s._id),
        name: s.name,
        tag: s.tag,
        createdAt: s.createdAt,
        members: s.members.map((m) => ({
          name: m.user?.name ?? "Fan",
          email: m.user?.email ?? null,
          captain: String(m.user?._id) === String(s.captain),
          score: byUser.get(String(m.user?._id)) ?? 0,
        })),
      }))
    );
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/admin/squads/:id — close a squad (an offensive name, say). Members are free to join another. */
export async function adminDeleteSquad(req: Request, res: Response, next: NextFunction) {
  try {
    if (!Types.ObjectId.isValid(String(req.params.id))) throw httpError(400, "Invalid squad");
    await Squad.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
