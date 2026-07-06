import { Request, Response, NextFunction } from "express";
import { User } from "../models/User";
import { Release } from "../models/Release";
import { fullStreamUrl } from "../services/cloudinary";

/**
 * GET /api/stream/:slug — returns a signed, full-length streaming URL for a song,
 * but only to fans with an active streaming pass. The signed URL is short-lived
 * and playable directly by the audio element.
 */
export async function streamSong(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.fan?.id);
    if (!user || !user.streamUntil || user.streamUntil <= new Date()) {
      return res.status(403).json({ message: "No active streaming pass" });
    }

    const release = await Release.findOne({ slug: req.params.slug, hidden: { $ne: true } });
    if (!release || !release.audioKey) {
      return res.status(404).json({ message: "This song isn't available to stream here" });
    }

    res.json({ url: fullStreamUrl(release.audioKey) });
  } catch (err) {
    next(err);
  }
}
