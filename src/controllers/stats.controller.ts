import { Request, Response, NextFunction } from "express";
import { Stats } from "../models/Stats";
import { DailyVisit } from "../models/DailyVisit";
import { VisitCountry } from "../models/VisitCountry";
import { Release } from "../models/Release";
import { Beat } from "../models/Beat";
import { lookupCountry } from "../services/geo";

const dateStr = (d: Date) => d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

/** Resolve the visitor's country (best-effort) and bump its counter. */
async function resolveVisitCountry(ip?: string) {
  try {
    const code = await lookupCountry(ip);
    if (code) await VisitCountry.updateOne({ code }, { $inc: { count: 1 } }, { upsert: true });
  } catch {
    /* countries are best-effort — never surface an error */
  }
}

/**
 * POST /api/visits — records a visit (bumps the all-time total + today's count)
 * and returns today's count, which is what the public footer shows.
 */
export async function recordVisit(req: Request, res: Response, next: NextFunction) {
  try {
    const now = new Date();
    const [, daily] = await Promise.all([
      // Keep the all-time counter running for the admin panel.
      Stats.findOneAndUpdate({}, { $inc: { visits: 1 } }, { upsert: true, new: true }),
      DailyVisit.findOneAndUpdate(
        { date: dateStr(now) },
        { $inc: { count: 1, [`hours.${now.getUTCHours()}`]: 1 } },
        { upsert: true, new: true }
      ),
    ]);
    res.json({ visits: daily?.count ?? 0 });

    // Fire-and-forget geo lookup so it never delays the response.
    void resolveVisitCountry(req.ip);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/plays — counts one on-site audio play (previews / player).
 * Optional body { kind: "release" | "beat", refId } also bumps that track's own
 * counter, which powers the "Trending" section.
 */
export async function recordPlay(req: Request, res: Response, next: NextFunction) {
  try {
    const stats = await Stats.findOneAndUpdate(
      {},
      { $inc: { plays: 1 } },
      { upsert: true, new: true }
    );

    const { kind, refId } = (req.body ?? {}) as { kind?: string; refId?: string };
    if (refId) {
      // Swallow a bad id — the global count already succeeded.
      const bump = { $inc: { plays: 1 } };
      if (kind === "release") await Release.updateOne({ _id: refId }, bump).catch(() => {});
      else if (kind === "beat") await Beat.updateOne({ _id: refId }, bump).catch(() => {});
    }

    res.json({ plays: stats.plays });
  } catch (err) {
    next(err);
  }
}

/** GET /api/stats — public live counters for the homepage stats band. */
export async function getPublicStats(_req: Request, res: Response, next: NextFunction) {
  try {
    const [stats, countries] = await Promise.all([
      Stats.findOne({}),
      VisitCountry.countDocuments(),
    ]);
    res.json({
      plays: stats?.plays ?? 0,
      downloads: stats?.downloads ?? 0,
      beats: stats?.beatSales ?? 0,
      merch: stats?.merchSales ?? 0,
      countries,
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/visits — public count of today's visits (shown in the footer). */
export async function getVisitTotal(_req: Request, res: Response, next: NextFunction) {
  try {
    const count = (await DailyVisit.findOne({ date: dateStr(new Date()) }))?.count ?? 0;
    res.json({ visits: count });
  } catch (err) {
    next(err);
  }
}

const DAY_MS = 86400000;
const MAX_RANGE_DAYS = 366;
const isDate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(`${v}T00:00:00Z`));
const addDays = (date: string, n: number) =>
  dateStr(new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS));

/** Every YYYY-MM-DD from `from` to `to`, inclusive. */
function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Daily counts, the 24-hour profile and the total for a run of dates. */
async function visitsFor(dates: string[]) {
  const docs = await DailyVisit.find({ date: { $in: dates } });
  const byDate = new Map(docs.map((d) => [d.date, d]));
  const hourly = Array<number>(24).fill(0);
  let hourlyTracked = 0;
  const daily = dates.map((date) => {
    const doc = byDate.get(date);
    doc?.hours?.forEach((n, h) => {
      hourly[Number(h)] += n;
      hourlyTracked += n;
    });
    return { date, count: doc?.count ?? 0 };
  });
  const total = daily.reduce((s, d) => s + d.count, 0);
  return { daily, hourly, hourlyTracked, total };
}

/**
 * GET /api/admin/visits?from=YYYY-MM-DD&to=YYYY-MM-DD (admin only).
 * Visits per day and per hour (UTC = Ghana time) for the range, the same-length
 * period just before it for comparison, and the all-time total. Without a range
 * it returns the last 7 days (`?days=N` still works).
 */
export async function getStats(req: Request, res: Response, next: NextFunction) {
  try {
    const today = dateStr(new Date());
    let { from, to } = req.query as { from?: string; to?: string };
    if (!isDate(from) || !isDate(to)) {
      const days = Math.min(Math.max(Number(req.query.days) || 7, 1), MAX_RANGE_DAYS);
      to = today;
      from = addDays(today, -(days - 1));
    }
    if (from > to) [from, to] = [to, from];
    if (to > today) to = today;
    if (from > to) from = to;
    const dates = datesBetween(from, to).slice(-MAX_RANGE_DAYS);
    from = dates[0];

    const prevTo = addDays(from, -1);
    const prevFrom = addDays(prevTo, -(dates.length - 1));

    const [stats, current, previous, firstDay] = await Promise.all([
      Stats.findOne({}),
      visitsFor(dates),
      visitsFor(datesBetween(prevFrom, prevTo)),
      DailyVisit.findOne({}).sort({ date: 1 }).select("date"),
    ]);

    res.json({
      total: stats?.visits ?? 0, // all time
      from,
      to,
      rangeTotal: current.total,
      daily: current.daily,
      hourly: current.hourly,
      hourlyTracked: current.hourlyTracked,
      previous: { from: prevFrom, to: prevTo, total: previous.total },
      firstDate: firstDay?.date ?? null,
    });
  } catch (err) {
    next(err);
  }
}
