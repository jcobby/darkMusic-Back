import { Request, Response, NextFunction } from "express";
import { Types, type Model } from "mongoose";
import { GameEvent, GameEventEntry, type IGameEvent } from "../models/GameEvent";
import type { IBoardEntry } from "../models/GameScore";
import { WalletTxn } from "../models/Wallet";
import { GAME_PRIZE, BOARD_ORDER } from "../services/prizes";
import { eventView, eventStatus, forgetEvents, reassessEvent, settleEvent } from "../services/events";
import { dayOf } from "../services/gameScoring";
import { slugify } from "../utils/slug";
import { readBoard, pageOf } from "./games.controller";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const ENTRIES = GameEventEntry as unknown as Model<IBoardEntry>;
/** The games events can be held in. */
const EVENT_GAMES: string[] = [GAME_PRIZE.game, "pool"];
const DAY = 86400e3;

// ---------- Public ----------

/** GET /api/events?game=beat-breaker|pool — what's on now, what's coming and recent results. */
export async function listEvents(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.query.game || GAME_PRIZE.game);
    const now = Date.now();
    const events = await GameEvent.find({
      game,
      cancelled: { $ne: true },
      endsAt: { $gt: new Date(now - 14 * DAY) },
      startsAt: { $lt: new Date(now + 60 * DAY) },
    }).sort({ startsAt: 1 });
    const players = await Promise.all(events.map((ev) => GameEventEntry.countDocuments({ event: ev._id, score: { $gt: 0 } })));
    const views = events.map((ev, i) => ({ ...eventView(ev, now), players: players[i] }));
    res.json({
      live: views.filter((v) => v.status === "live"),
      upcoming: views.filter((v) => v.status === "upcoming"),
      recent: views.filter((v) => v.status === "ended").reverse(),
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/events/:slug?offset=0&limit=20 — the event, its board and (signed in) where you stand. */
export async function getEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const ev = await GameEvent.findOne({ slug: String(req.params.slug) });
    if (!ev) throw httpError(404, "Event not found");
    if (eventStatus(ev) === "ended" && !ev.settledAt) await settleEvent(ev).catch(() => {});
    const board = await readBoard(ENTRIES, { event: ev._id }, { ...pageOf(req), userId: req.fan?.id });
    res.json({ event: eventView(ev), ...board });
  } catch (err) {
    next(err);
  }
}

// ---------- Admin ----------

async function uniqueSlug(base: string) {
  const root = slugify(base) || "event";
  let slug = root;
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await GameEvent.exists({ slug })) slug = `${root}-${++n}`;
  return slug;
}

/** Splits like "60, 25, 15" (or an array) → [60, 25, 15]. */
const splitFrom = (v: unknown): number[] =>
  (Array.isArray(v) ? v : String(v ?? "").split(/[\s,/]+/))
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0);

/** The event fields from a form, checked. `started`: only the title and description can still change. */
function eventInput(b: Record<string, unknown>, existing?: IGameEvent) {
  const started = Boolean(existing && existing.startsAt.getTime() <= Date.now());
  const out: Partial<Pick<IGameEvent, "title" | "description" | "game" | "kind" | "metric" | "startsAt" | "endsAt" | "prizeGhs" | "split">> = {};
  if (b.title !== undefined || !existing) {
    const title = String(b.title ?? "").trim();
    if (title.length < 3 || title.length > 80) throw httpError(400, "Give the event a title (3–80 characters)");
    out.title = title;
  }
  if (b.description !== undefined) out.description = String(b.description).trim().slice(0, 600) || undefined;

  if (started) {
    // The admin form sends every field back; only refuse when one of them actually changed.
    const differs = (k: "game" | "kind" | "metric" | "startsAt" | "endsAt" | "prizeGhs" | "split") =>
      b[k] !== undefined &&
      (k === "startsAt" || k === "endsAt"
        ? new Date(String(b[k])).getTime() !== existing![k].getTime()
        : k === "split"
          ? existing!.prizeGhs > 0 && splitFrom(b.split).join() !== existing!.split.join()
          : String(b[k]) !== String(existing![k]));
    if ((["game", "kind", "metric", "startsAt", "endsAt", "prizeGhs", "split"] as const).some(differs)) {
      throw httpError(409, "This event has started — only its title and description can change now");
    }
    return out;
  }

  const kind = b.kind ?? existing?.kind;
  if (kind !== "weekly" && kind !== "live") throw httpError(400, "Choose weekly challenge or live event");
  out.kind = kind;
  const game = String(b.game ?? existing?.game ?? GAME_PRIZE.game);
  if (!EVENT_GAMES.includes(game)) throw httpError(400, "Choose Beat Breaker or Pool");
  out.game = game;
  // Beat Breaker: the best game, or the best game each day added up · Pool: ranked wins
  const metric = game === "pool" ? "wins" : (b.metric ?? existing?.metric ?? "best");
  if (metric !== "best" && metric !== "days" && metric !== "wins") throw httpError(400, "Choose how the event is scored");
  if (game !== "pool" && metric === "wins") throw httpError(400, "Beat Breaker events are scored by points");
  out.metric = metric;

  const startsAt = b.startsAt !== undefined ? new Date(String(b.startsAt)) : existing?.startsAt;
  const endsAt = b.endsAt !== undefined ? new Date(String(b.endsAt)) : existing?.endsAt;
  if (!startsAt || !endsAt || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw httpError(400, "Set when it starts and ends");
  if (endsAt.getTime() - startsAt.getTime() < 10 * 60e3) throw httpError(400, "An event lasts at least 10 minutes");
  if (endsAt.getTime() - startsAt.getTime() > 31 * DAY) throw httpError(400, "An event lasts at most 31 days");
  if (endsAt.getTime() <= Date.now()) throw httpError(400, "That end time has already passed");
  out.startsAt = startsAt;
  out.endsAt = endsAt;

  const prizeGhs = Math.round(Number(b.prizeGhs ?? existing?.prizeGhs ?? 0) * 100) / 100;
  if (!Number.isFinite(prizeGhs) || prizeGhs < 0 || prizeGhs > 100000) throw httpError(400, "The prize must be between GH₵0 and GH₵100,000");
  out.prizeGhs = prizeGhs;
  const split = b.split !== undefined ? splitFrom(b.split) : existing?.split ?? [100];
  if (prizeGhs > 0) {
    if (!split.length || split.length > 10) throw httpError(400, "Pay between 1 and 10 places");
    if (Math.abs(split.reduce((s, x) => s + x, 0) - 100) > 0.01) throw httpError(400, "The prize split must add up to 100%");
  }
  out.split = prizeGhs > 0 ? split : [100];
  return out;
}

const adminView = async (ev: IGameEvent) => ({
  id: String(ev._id),
  ...eventView(ev),
  split: ev.split,
  cancelled: ev.cancelled,
  settledAt: ev.settledAt ?? null,
  players: await GameEventEntry.countDocuments({ event: ev._id, score: { $gt: 0 } }),
});

/** GET /api/admin/events — every event, newest first. */
export async function adminListEvents(_req: Request, res: Response, next: NextFunction) {
  try {
    const events = await GameEvent.find().sort({ startsAt: -1 }).limit(60);
    res.json(await Promise.all(events.map(adminView)));
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/events { title, description?, kind, metric, startsAt, endsAt, prizeGhs, split } */
export async function adminCreateEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const input = eventInput(req.body ?? {});
    const ev = await GameEvent.create({
      ...input,
      slug: await uniqueSlug(`${input.title}-${dayOf(input.startsAt!)}`),
      createdBy: req.admin?.email,
    });
    forgetEvents();
    res.status(201).json(await adminView(ev));
  } catch (err) {
    next(err);
  }
}

const findEvent = async (id: unknown) => {
  if (!Types.ObjectId.isValid(String(id))) throw httpError(400, "Invalid event");
  const ev = await GameEvent.findById(String(id));
  if (!ev) throw httpError(404, "Event not found");
  return ev;
};

/** PUT /api/admin/events/:id — change it (once it has started, only the title and description). */
export async function adminUpdateEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const ev = await findEvent(req.params.id);
    if (ev.cancelled) throw httpError(409, "This event was cancelled");
    if (ev.settledAt) throw httpError(409, "This event is over and paid out");
    ev.set(eventInput(req.body ?? {}, ev));
    await ev.save();
    forgetEvents();
    res.json(await adminView(ev));
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/events/:id/cancel — call it off (nothing is paid). Only before it's paid out. */
export async function adminCancelEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const ev = await findEvent(req.params.id);
    if (ev.settledAt) throw httpError(409, "This event is already paid out — disqualify players instead");
    ev.cancelled = true;
    await ev.save();
    forgetEvents();
    res.json(await adminView(ev));
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/events/:id/board — the top 100 with contact details, and the prizes paid. */
export async function adminEventBoard(req: Request, res: Response, next: NextFunction) {
  try {
    const ev = await findEvent(req.params.id);
    const [rows, prizes] = await Promise.all([
      GameEventEntry.find({ event: ev._id, score: { $gt: 0 } })
        .sort(BOARD_ORDER)
        .limit(100)
        .populate<{ user: { _id: Types.ObjectId; name?: string; email: string; phone?: string } }>("user", "name email phone"),
      WalletTxn.find({ kind: "prize", event: ev._id }).sort({ place: 1, createdAt: 1 }),
    ]);
    let rank = 0; // disqualified players don't take a place
    res.json({
      event: await adminView(ev),
      top: rows.map((e) => ({
        rank: e.disqualified ? null : ++rank,
        disqualified: Boolean(e.disqualified),
        userId: String(e.user?._id ?? e.populated("user") ?? ""),
        name: e.user?.name ?? e.name,
        email: e.user?.email ?? null,
        phone: e.user?.phone ?? null,
        score: e.score,
        level: e.level,
        days: e.days ?? null,
        runs: e.runs,
        achievedAt: e.achievedAt,
      })),
      prizes: prizes.map((p) => ({ userId: String(p.user), place: p.place ?? null, amountGhs: p.amountGhs, status: p.status, availableAt: p.availableAt ?? null })),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/events/:id/disqualify { userId, disqualified } — take a player off the
 * event's board (or put them back). Once it's paid out, prizes move to match — unless
 * one has already been withdrawn.
 */
export async function adminEventDisqualify(req: Request, res: Response, next: NextFunction) {
  try {
    const ev = await findEvent(req.params.id);
    const userId = String(req.body?.userId || "");
    if (!Types.ObjectId.isValid(userId)) throw httpError(400, "Choose a player");
    const disqualified = req.body?.disqualified === true || req.body?.disqualified === "true";
    const before = await GameEventEntry.findOne({ event: ev._id, user: userId });
    if (!before) throw httpError(404, "That player isn't in this event");
    await GameEventEntry.updateOne({ _id: before._id }, { $set: { disqualified } });
    const r = await reassessEvent(ev);
    if (!r.ok) {
      await GameEventEntry.updateOne({ _id: before._id }, { $set: { disqualified: before.disqualified } });
      throw httpError(409, r.message ?? "Couldn't move the prizes");
    }
    res.json({ ok: true, disqualified });
  } catch (err) {
    next(err);
  }
}
