import { Types } from "mongoose";
import { env } from "../config/env";
import { GameEvent, GameEventEntry, type IGameEvent } from "../models/GameEvent";
import { User } from "../models/User";
import { WalletTxn, type IWalletTxn } from "../models/Wallet";
import { sendNotification } from "./mailer";
import { BOARD_ORDER, REVIEW_HOURS, email, ghs, voidable } from "./prizes";
import { dayOf } from "./gameScoring";
import { forgetWins } from "./flair";

/**
 * Game events (models/GameEvent), start to finish:
 *  1. DMY schedules one in admin: a window, how it's scored, the prize and its split.
 *  2. While it runs, every saved game that STARTED in the window adds to the event's
 *     board (alongside the month's and the week's) — what it scores before the end counts.
 *  3. When it ends, the top places' prizes go into their DMY wallets for the usual
 *     score check (REVIEW_HOURS), then they withdraw to Mobile Money.
 *  4. Disqualifying a placed player afterwards moves the prizes down the board —
 *     unless one has already been withdrawn.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
export const placeName = (n: number) => (n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);
/** What a place wins (0 past the paid places, or with no prize). */
export const prizeFor = (ev: Pick<IGameEvent, "prizeGhs" | "split">, place: number) =>
  ev.prizeGhs > 0 ? round2((ev.prizeGhs * (ev.split[place - 1] ?? 0)) / 100) : 0;
export const eventStatus = (ev: Pick<IGameEvent, "cancelled" | "startsAt" | "endsAt">, now = Date.now()) =>
  ev.cancelled ? "cancelled" : now < ev.startsAt.getTime() ? "upcoming" : now < ev.endsAt.getTime() ? "live" : "ended";
const when = (d: Date) =>
  d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Accra" });
const isDuplicate = (err: unknown) => (err as { code?: number })?.code === 11000;

/** An event as fans see it. */
export function eventView(ev: IGameEvent, now = Date.now()) {
  return {
    slug: ev.slug,
    title: ev.title,
    description: ev.description ?? null,
    game: ev.game,
    kind: ev.kind,
    metric: ev.metric,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt,
    status: eventStatus(ev, now),
    prizeGhs: ev.prizeGhs,
    prizes: ev.prizeGhs > 0 ? ev.split.map((_, i) => prizeFor(ev, i + 1)) : [],
    winners: ev.settledAt ? ev.winners.map((w) => ({ place: w.place, name: w.name, score: w.score, amountGhs: w.amountGhs })) : [],
  };
}

// ---------- Counting games ----------

// Every score save looks up the events still to come, so they're kept for a few seconds.
const notOver = new Map<string, { at: number; events: IGameEvent[] }>();
const NOT_OVER_TTL = 20_000;
/** Forget the cached events (DMY created, changed or cancelled one). */
export const forgetEvents = () => notOver.clear();

async function eventsNotOver(game: string) {
  const hit = notOver.get(game);
  if (hit && Date.now() - hit.at < NOT_OVER_TTL) return hit.events;
  const events = await GameEvent.find({ game, cancelled: { $ne: true }, endsAt: { $gt: new Date() } });
  notOver.set(game, { at: Date.now(), events });
  return events;
}

/**
 * A saved game: add it to every event it counts for — it started in the event's
 * window and the event isn't over. Scores only go up (saves can arrive out of order).
 */
export async function recordEventGame(
  player: { id: Types.ObjectId; name: string },
  game: string,
  run: { startedAt: number; score: number; level: number; firstSave: boolean },
  now: Date
) {
  const events = (await eventsNotOver(game)).filter(
    (ev) => ev.startsAt.getTime() <= run.startedAt && run.startedAt < ev.endsAt.getTime() && now < ev.endsAt
  );
  for (const ev of events) {
    const key = { event: ev._id, user: player.id };
    const day = dayOf(new Date(run.startedAt));
    await GameEventEntry.updateOne(
      key,
      {
        $setOnInsert: { game, score: 0, achievedAt: now },
        $set: { name: player.name },
        $max: { level: run.level, bestRun: run.score, ...(ev.metric === "days" ? { [`byDay.${day}`]: run.score } : {}) },
        ...(run.firstSave ? { $inc: { runs: 1 } } : {}),
      },
      { upsert: true }
    );
    let total = run.score;
    if (ev.metric === "days") {
      const byDay = (await GameEventEntry.findOne(key).select("byDay").lean())?.byDay ?? {};
      total = Object.values(byDay).reduce((s, v) => s + v, 0);
      await GameEventEntry.updateOne(key, { $max: { days: Object.keys(byDay).length } });
    }
    // A tie keeps whoever got there first.
    await GameEventEntry.updateOne({ ...key, score: { $lt: total } }, { $set: { score: total, achievedAt: now } });
  }
}

/**
 * A finished ranked Pool match: a win (+1) for the winner, a game played for both,
 * in every "wins" event it counts for — it started in the window, the event isn't over.
 */
export async function recordEventMatch(
  player: { id: Types.ObjectId; name: string },
  game: string,
  match: { startedAt: number; won: boolean },
  now: Date
) {
  const events = (await eventsNotOver(game)).filter(
    (ev) => ev.metric === "wins" && ev.startsAt.getTime() <= match.startedAt && now < ev.endsAt
  );
  for (const ev of events) {
    const key = { event: ev._id, user: player.id };
    await GameEventEntry.updateOne(
      key,
      { $setOnInsert: { game, score: 0, level: 0, achievedAt: now }, $set: { name: player.name }, $inc: { runs: 1 } },
      { upsert: true }
    );
    if (match.won) await GameEventEntry.updateOne(key, { $inc: { score: 1 }, $set: { achievedAt: now } });
  }
}

// ---------- Paying out ----------

interface Placing {
  place: number;
  user: Types.ObjectId;
  name: string;
  score: number;
  amountGhs: number;
}

/** The finished event's top places (at least the top 3, kept for the record). */
async function placings(ev: IGameEvent): Promise<Placing[]> {
  const top = await GameEventEntry.find({ event: ev._id, score: { $gt: 0 }, disqualified: { $ne: true } })
    .sort(BOARD_ORDER)
    .limit(Math.max(3, ev.prizeGhs > 0 ? ev.split.length : 0))
    .lean();
  return top.map((e, i) => ({ place: i + 1, user: e.user, name: e.name, score: e.score, amountGhs: prizeFor(ev, i + 1) }));
}

/** Put a place's prize in the winner's wallet. False if it's already there. */
async function credit(ev: IGameEvent, w: Placing): Promise<boolean> {
  try {
    await WalletTxn.create({
      user: w.user,
      kind: "prize",
      amountGhs: w.amountGhs,
      status: "review",
      game: ev.game,
      event: ev._id,
      place: w.place,
      eventPlace: `${ev._id}:${w.place}`,
      score: w.score,
      note: `${ev.title} · ${placeName(w.place)} place`,
      availableAt: new Date(Math.max(Date.now(), ev.endsAt.getTime()) + REVIEW_HOURS * 3600e3),
    });
    return true;
  } catch (err) {
    if (isDuplicate(err)) return false;
    throw err;
  }
}

async function wonEmail(ev: IGameEvent, w: Placing) {
  const user = await User.findById(w.user);
  const availableAt = new Date(Math.max(Date.now(), ev.endsAt.getTime()) + REVIEW_HOURS * 3600e3);
  void email(user?.email, {
    title: `${placeName(w.place)} in ${ev.title} — you won ${ghs(w.amountGhs)}! ⚡`,
    intro:
      `You finished ${placeName(w.place)} in ${ev.title} with ${w.score.toLocaleString("en-US")} ${ev.metric === "wins" ? "wins" : "points"}. ` +
      `${ghs(w.amountGhs)} is now in your DMY wallet. After a quick score check you can withdraw it to Mobile Money — from ${when(availableAt)}.`,
    button: { label: "See my wallet", url: `${env.clientUrl}/account#wallet` },
  });
}

/** Once an event is over, pay its prizes into the winners' wallets. Safe to call again — it only acts once. */
export async function settleEvent(ev: IGameEvent): Promise<void> {
  if (ev.cancelled || ev.settledAt || ev.endsAt.getTime() > Date.now()) return;
  const winners = await placings(ev);
  for (const w of winners) if (w.amountGhs > 0) await credit(ev, w);
  const claimed = await GameEvent.updateOne({ _id: ev._id, settledAt: null }, { $set: { settledAt: new Date(), winners } });
  if (!claimed.modifiedCount) return; // settled elsewhere at the same moment
  forgetWins(); // ⚡ badges
  const paid = winners.filter((w) => w.amountGhs > 0);
  for (const w of paid) await wonEmail(ev, w);
  const total = round2(paid.reduce((s, w) => s + w.amountGhs, 0));
  void sendNotification(
    `⚡ ${ev.title} — results`,
    (winners.length
      ? winners
          .map((w) => `${placeName(w.place)}: ${w.name} — ${w.score} ${ev.metric === "wins" ? "wins" : "pts"}${w.amountGhs ? ` → ${ghs(w.amountGhs)}` : ""}`)
          .join("\n")
      : "Nobody played.") +
      (total
        ? `\n\n${ghs(total)} is in the winners' wallets for a ${REVIEW_HOURS}-hour score check. Check their scores in admin → Events (Disqualify moves a prize down the board), and make sure your Paystack balance covers their withdrawals.`
        : "")
  ).catch(() => {});
}

/** Run by the server every minute: pay out events that have just ended. */
export async function sweepEvents(): Promise<void> {
  const due = await GameEvent.find({ cancelled: { $ne: true }, settledAt: null, endsAt: { $lte: new Date() } }).limit(10);
  for (const ev of due) await settleEvent(ev);
}

/**
 * After DMY disqualifies (or restores) a player in a finished event: move the prizes
 * that change hands. Fails — changing nothing — if one of them has been withdrawn.
 */
export async function reassessEvent(ev: IGameEvent): Promise<{ ok: boolean; message?: string }> {
  if (!ev.settledAt) return { ok: true }; // still to be paid: it pays whoever's on top then
  const intended = await placings(ev);
  const standing = await WalletTxn.find({ kind: "prize", event: ev._id, eventPlace: { $exists: true } });
  const key = (user: unknown, place: number | undefined, amount: number) => `${String(user)}:${place}:${amount}`;
  const want = new Set(intended.filter((w) => w.amountGhs > 0).map((w) => key(w.user, w.place, w.amountGhs)));
  const have = new Set(standing.map((p) => key(p.user, p.place, p.amountGhs)));

  const toVoid: IWalletTxn[] = standing.filter((p) => !want.has(key(p.user, p.place, p.amountGhs)));
  for (const p of toVoid) {
    if (!(await voidable(p))) {
      return { ok: false, message: "A winner has already withdrawn (or is withdrawing) their prize — reject the withdrawal first." };
    }
  }
  // Someone who just moves place only hears about their new prize.
  const stillPaid = new Set(intended.filter((w) => w.amountGhs > 0).map((w) => String(w.user)));
  for (const p of toVoid) {
    await WalletTxn.updateOne({ _id: p._id, eventPlace: { $exists: true } }, { $set: { status: "void" }, $unset: { eventPlace: "" } });
    if (stillPaid.has(String(p.user))) continue;
    const user = await User.findById(p.user);
    void email(user?.email, {
      title: `Update on your ${ev.title} prize`,
      intro: `After DMY's review of the results, your ${placeName(p.place ?? 0)} place prize (${ghs(p.amountGhs)}) for ${ev.title} has changed and was removed from your wallet. Contact DMY if you think this is a mistake.`,
    });
  }
  for (const w of intended) {
    if (w.amountGhs > 0 && !have.has(key(w.user, w.place, w.amountGhs)) && (await credit(ev, w))) await wonEmail(ev, w);
  }
  await GameEvent.updateOne({ _id: ev._id }, { $set: { winners: intended } });
  forgetWins();
  return { ok: true };
}
