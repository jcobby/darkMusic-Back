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
    const [, daily] = await Promise.all([
      // Keep the all-time counter running for the admin panel.
      Stats.findOneAndUpdate({}, { $inc: { visits: 1 } }, { upsert: true, new: true }),
      DailyVisit.findOneAndUpdate(
        { date: dateStr(new Date()) },
        { $inc: { count: 1 } },
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

/** GET /api/admin/visits — all-time total + the last 7 days (admin only). */
export async function getStats(req: Request, res: Response, next: NextFunction) {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const total = (await Stats.findOne({}))?.visits ?? 0;

    const today = new Date();
    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(today.getUTCDate() - i);
      dates.push(dateStr(d));
    }

    const docs = await DailyVisit.find({ date: { $in: dates } });
    const counts = new Map(docs.map((d) => [d.date, d.count]));
    const daily = dates.map((date) => ({ date, count: counts.get(date) ?? 0 }));

    res.json({ total, daily });
  } catch (err) {
    next(err);
  }
}
