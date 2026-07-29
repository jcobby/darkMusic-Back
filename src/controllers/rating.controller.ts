import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { Rating } from "../models/Rating";
import { Video } from "../models/Video";
import { imageUrl } from "../utils/media";
import { FanTokenPayload } from "../middleware/auth";

const visible = { hidden: { $ne: true } };
const avgOf = (sum: number, count: number) => (count ? Math.round((sum / count) * 10) / 10 : 0);

/** Resolve the fan id from a token if present, without requiring it. */
function optionalFanId(req: Request): string | null {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  try {
    const p = jwt.verify(token, env.jwtSecret) as FanTokenPayload;
    return p.role === "fan" ? p.id : null;
  } catch {
    return null;
  }
}

/** GET /api/videos — content-creation videos with their average rating. */
export async function listVideos(req: Request, res: Response, next: NextFunction) {
  try {
    const fanId = optionalFanId(req);
    const videos = await Video.find(visible).sort({ order: 1, createdAt: -1 });

    let mine = new Map<string, number>();
    if (fanId) {
      const rows = await Rating.find({
        user: fanId,
        video: { $in: videos.map((v) => String(v._id)) },
      });
      mine = new Map(rows.map((m) => [m.video, m.stars]));
    }

    res.json(
      videos.map((v) => ({
        id: String(v._id),
        title: v.title,
        creator: v.creator || null,
        description: v.description || null,
        videoUrl: v.videoUrl,
        poster: imageUrl(v.poster),
        avgRating: avgOf(v.ratingSum, v.ratingCount),
        ratingCount: v.ratingCount,
        myStars: mine.get(String(v._id)) ?? 0,
      }))
    );
  } catch (err) {
    next(err);
  }
}

/** POST /api/videos/:id/rate — set the fan's 1–5 star rating for a video. */
export async function rateVideo(req: Request, res: Response, next: NextFunction) {
  try {
    const stars = Math.round(Number(req.body?.stars));
    if (!Number.isFinite(stars) || stars < 1 || stars > 5) {
      return res.status(400).json({ message: "Pick 1 to 5 stars" });
    }
    const video = await Video.findOne({ _id: req.params.id, ...visible });
    if (!video) return res.status(404).json({ message: "Video not found" });

    const vid = String(video._id);
    const existing = await Rating.findOne({ user: req.fan!.id, video: vid });
    if (existing) {
      const delta = stars - existing.stars;
      if (delta !== 0) {
        existing.stars = stars;
        await existing.save();
        video.ratingSum += delta;
        await video.save();
      }
    } else {
      await Rating.create({ user: req.fan!.id, video: vid, stars });
      video.ratingSum += stars;
      video.ratingCount += 1;
      await video.save();
    }

    res.json({
      avgRating: avgOf(video.ratingSum, video.ratingCount),
      ratingCount: video.ratingCount,
      myStars: stars,
    });
  } catch (err) {
    next(err);
  }
}
