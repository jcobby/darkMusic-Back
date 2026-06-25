import { Request, Response, NextFunction } from "express";
import { Stats } from "../models/Stats";
import { DailyVisit } from "../models/DailyVisit";

const dateStr = (d: Date) => d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

/** POST /api/visits — records a visit (bumps the all-time total + today's count). */
export async function recordVisit(_req: Request, res: Response, next: NextFunction) {
  try {
    const [stats] = await Promise.all([
      Stats.findOneAndUpdate({}, { $inc: { visits: 1 } }, { upsert: true, new: true }),
      DailyVisit.findOneAndUpdate(
        { date: dateStr(new Date()) },
        { $inc: { count: 1 } },
        { upsert: true }
      ),
    ]);
    res.json({ visits: stats.visits });
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
