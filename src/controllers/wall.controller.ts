import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { FanPost, IFanPost } from "../models/FanPost";
import { User } from "../models/User";
import { uploadBuffer } from "../services/cloudinary";
import { FanTokenPayload } from "../middleware/auth";

/** Resolve the fan id from a token if one is present — without requiring it. */
function optionalFanId(req: Request): string | null {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  try {
    const payload = jwt.verify(token, env.jwtSecret) as FanTokenPayload;
    return payload.role === "fan" ? payload.id : null;
  } catch {
    return null;
  }
}

function publicPost(p: IFanPost, viewerId: string | null) {
  return {
    id: String(p._id),
    name: p.authorName,
    body: p.body,
    image: p.image ?? null,
    likes: p.likedBy.length,
    likedByMe: viewerId ? p.likedBy.includes(viewerId) : false,
    createdAt: p.createdAt,
  };
}

/** GET /api/wall — public feed (newest first). */
export async function listWall(req: Request, res: Response, next: NextFunction) {
  try {
    const viewerId = optionalFanId(req);
    const posts = await FanPost.find().sort({ createdAt: -1 }).limit(60);
    res.json(posts.map((p) => publicPost(p, viewerId)));
  } catch (err) {
    next(err);
  }
}

/** POST /api/wall — create a post (requires a fan; optional "photo" file). */
export async function createPost(req: Request, res: Response, next: NextFunction) {
  try {
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    const file = req.file;
    if (!body && !file) {
      return res.status(400).json({ message: "Add a message or a photo" });
    }
    if (body.length > 500) {
      return res.status(400).json({ message: "Message is too long (max 500 characters)" });
    }

    const author = await User.findById(req.fan!.id);
    if (!author) return res.status(404).json({ message: "Account not found" });

    let image: string | undefined;
    if (file) {
      const uploaded = await uploadBuffer(file.buffer, "image");
      image = uploaded.url;
    }

    const post = await FanPost.create({
      user: req.fan!.id,
      authorName: author.name || "Fan",
      body,
      image,
    });
    res.status(201).json(publicPost(post, req.fan!.id));
  } catch (err) {
    next(err);
  }
}

/** POST /api/wall/:id/like — toggle a like (requires a fan). */
export async function toggleLike(req: Request, res: Response, next: NextFunction) {
  try {
    const post = await FanPost.findById(req.params.id);
    if (!post) return res.status(404).json({ message: "Post not found" });

    const fanId = req.fan!.id;
    const i = post.likedBy.indexOf(fanId);
    if (i >= 0) post.likedBy.splice(i, 1);
    else post.likedBy.push(fanId);
    await post.save();

    res.json({ likes: post.likedBy.length, likedByMe: i < 0 });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/admin/wall/:id — moderation (admin only). */
export async function deleteWallPost(req: Request, res: Response, next: NextFunction) {
  try {
    await FanPost.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
