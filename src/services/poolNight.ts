import { GameEvent } from "../models/GameEvent";
import { forgetEvents } from "./events";

/*
 * DMY Pool Night: every Thursday from 7pm Ghana time (GMT) — 7 to 10pm — the Lenko Army
 * plays ranked Pool together. Each week's night is an ordinary Pool event (services/events):
 * its own board of ranked wins, page and share link. It's made automatically ahead of time,
 * and DMY can add a prize to a week's night, change it or cancel it in admin like any event.
 */
export const POOL_NIGHT = { weekday: 4, startHour: 19, hours: 3 }; // Thursday, 19:00–22:00 GMT
const HOUR = 3600e3;

/** The Pool Night that's on now, or the next one. */
export function poolNightWindow(now = Date.now()) {
  const d = new Date(now);
  const daysAhead = (POOL_NIGHT.weekday - d.getUTCDay() + 7) % 7;
  let start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysAhead, POOL_NIGHT.startHour);
  if (now >= start + POOL_NIGHT.hours * HOUR) start += 7 * 24 * HOUR; // tonight's is over: next week's
  return { startsAt: new Date(start), endsAt: new Date(start + POOL_NIGHT.hours * HOUR) };
}

/** Is a Pool Night on right now? */
export const isPoolNight = (now = Date.now()) => poolNightWindow(now).startsAt.getTime() <= now;

export const poolNightSlug = (startsAt: Date) => `pool-night-${startsAt.toISOString().slice(0, 10)}`;

/** Make sure the coming (or current) Pool Night exists as an event. Run by the server every minute — safe to repeat. */
export async function ensurePoolNight(now = Date.now()) {
  const { startsAt, endsAt } = poolNightWindow(now);
  try {
    const r = await GameEvent.updateOne(
      { slug: poolNightSlug(startsAt) },
      {
        $setOnInsert: {
          title: "DMY Pool Night",
          description:
            "Every Thursday from 7pm: the Lenko Army plays ranked Pool together. Every ranked match you start tonight counts — the most wins tops the night's board.",
          game: "pool",
          kind: "live",
          metric: "wins",
          startsAt,
          endsAt,
          prizeGhs: 0,
          split: [100],
          cancelled: false,
          winners: [],
          createdBy: "pool-night",
        },
      },
      { upsert: true }
    );
    if (r.upsertedCount) forgetEvents();
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err; // made at the same moment elsewhere
  }
}
