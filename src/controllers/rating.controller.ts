import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { Rating } from "../models/Rating";
import { Video } from "../models/Video";
import { Vote } from "../models/Vote";
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

/** GET /api/videos — content-creation videos, ranked by contest votes (leaderboard). */
export async function listVideos(req: Request, res: Response, next: NextFunction) {
  try {
    const fanId = optionalFanId(req);
    const videos = await Video.find(visible).sort({ voteCount: -1, ratingSum: -1, createdAt: -1 });

    let ratings = new Map<string, number>();
    let myVoteId: string | null = null;
    if (fanId) {
      const rows = await Rating.find({
        user: fanId,
        video: { $in: videos.map((v) => String(v._id)) },
      });
      ratings = new Map(rows.map((m) => [m.video, m.stars]));
      const vote = await Vote.findOne({ user: fanId });
      myVoteId = vote ? vote.video : null;
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
        myStars: ratings.get(String(v._id)) ?? 0,
        voteCount: v.voteCount,
        myVote: myVoteId === String(v._id),
      }))
    );
  } catch (err) {
    next(err);
  }
}

/** POST /api/videos/:id/vote — cast/move the fan's single "best video" vote (toggles off if re-voting the same one). */
export async function voteVideo(req: Request, res: Response, next: NextFunction) {
  try {
    const video = await Video.findOne({ _id: req.params.id, ...visible });
    if (!video) return res.status(404).json({ message: "Video not found" });
    const vid = String(video._id);
    const fanId = req.fan!.id;

    const existing = await Vote.findOne({ user: fanId });
    if (existing && existing.video === vid) {
      // Re-voting the same video removes the vote.
      await existing.deleteOne();
      await Video.updateOne({ _id: vid }, { $inc: { voteCount: -1 } });
      const fresh = await Video.findById(vid);
      return res.json({ myVote: false, voteCount: Math.max(0, fresh?.voteCount ?? 0) });
    }
    if (existing) {
      // Move the vote from the previous video to this one.
      await Video.updateOne({ _id: existing.video }, { $inc: { voteCount: -1 } });
      existing.video = vid;
      await existing.save();
    } else {
      await Vote.create({ user: fanId, video: vid });
    }
    await Video.updateOne({ _id: vid }, { $inc: { voteCount: 1 } });
    const fresh = await Video.findById(vid);
    res.json({ myVote: true, voteCount: fresh?.voteCount ?? 0 });
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
