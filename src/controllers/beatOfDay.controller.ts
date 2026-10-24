import { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import { Beat, type IBeat } from "../models/Beat";
import { BeatOfDay } from "../models/BeatOfDay";
import { publicBeat } from "../utils/serialize";
import { dayOf, addDays, isDay } from "../services/gameScoring";

/**
 * Beat of the Day: one DMY free beat featured each day. It opens every game that
 * day, and in Beat Breaker its kicks are worth triple instead of double while it
 * plays. DMY can pin a beat to a date; other days take the next beat in rotation.
 */
export const BEAT_OF_DAY_MULTIPLIER = 3;

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const ROTATION_FROM = Date.UTC(2026, 0, 1);

/** The beats that can be featured: on the site, with a free MP3 the games can play. */
const playable = () => Beat.find({ hidden: { $ne: true }, mp3FreeKey: { $exists: true, $ne: "" } }).sort({ createdAt: 1, _id: 1 });

/** The Beat of the Day for each of these days (pinned, or from the rotation). */
async function beatsFor(days: string[]) {
  const [beats, pins] = await Promise.all([playable(), BeatOfDay.find({ day: { $in: days } }).lean()]);
  const byId = new Map(beats.map((b) => [String(b._id), b]));
  return days.map((day) => {
    const pin = pins.find((p) => p.day === day);
    const pinned = pin ? byId.get(String(pin.beat)) : undefined;
    const n = Math.floor((Date.parse(`${day}T00:00:00Z`) - ROTATION_FROM) / 86400e3);
    const beat: IBeat | undefined = pinned ?? (beats.length ? beats[((n % beats.length) + beats.length) % beats.length] : undefined);
    return { day, beat, pinned: Boolean(pinned) };
  });
}

let cache: { day: string; at: number; value: unknown } | null = null;

/** GET /api/beat-of-the-day — today's beat (null when there are no free beats). */
export async function beatOfTheDay(_req: Request, res: Response, next: NextFunction) {
  try {
    const day = dayOf();
    if (cache && cache.day === day && Date.now() - cache.at < 60_000) return res.json(cache.value);
    const [today] = await beatsFor([day]);
    const value = { day, multiplier: BEAT_OF_DAY_MULTIPLIER, beat: today.beat ? publicBeat(today.beat) : null };
    cache = { day, at: Date.now(), value };
    res.json(value);
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/beat-of-the-day — the next 14 days, and the beats that can be pinned. */
export async function adminBeatSchedule(_req: Request, res: Response, next: NextFunction) {
  try {
    const today = dayOf();
    const days = Array.from({ length: 14 }, (_, i) => addDays(today, i));
    const [schedule, beats] = await Promise.all([beatsFor(days), playable()]);
    res.json({
      days: schedule.map((s) => ({ day: s.day, pinned: s.pinned, beat: s.beat ? { id: String(s.beat._id), title: s.beat.title } : null })),
      beats: beats.map((b) => ({ id: String(b._id), title: b.title })),
    });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/admin/beat-of-the-day { day, beatId } — pin a beat to a day (beatId null: back to the rotation). */
export async function adminPinBeat(req: Request, res: Response, next: NextFunction) {
  try {
    const day = String(req.body?.day || "");
    if (!isDay(day) || day < dayOf()) throw httpError(400, "Choose today or a day to come");
    const beatId = req.body?.beatId;
    if (beatId === null || beatId === "") {
      await BeatOfDay.deleteOne({ day });
    } else {
      if (!Types.ObjectId.isValid(String(beatId)) || !(await Beat.exists({ _id: beatId, hidden: { $ne: true }, mp3FreeKey: { $exists: true, $ne: "" } }))) {
        throw httpError(400, "Choose one of the free beats on the site");
      }
      await BeatOfDay.updateOne({ day }, { $set: { beat: beatId } }, { upsert: true });
    }
    cache = null;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
