import { Request, Response, NextFunction } from "express";
import { Model } from "mongoose";
import { User } from "../models/User";
import { Video } from "../models/Video";
import { ModelProfile } from "../models/ModelProfile";
import { slugify } from "../utils/slug";
import { UploadedFiles } from "../services/upload";
import { uploadBuffer, uploadVideo } from "../services/cloudinary";
import { sendNotification } from "../services/mailer";

const asNum = (v: unknown, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

async function uniqueSlug(
  model: Pick<Model<unknown>, "exists">,
  base: string
): Promise<string> {
  const root = slugify(base) || "model";
  let slug = root;
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await model.exists({ slug })) slug = `${root}-${++n}`;
  return slug;
}

/** POST /api/account/submissions/video — a user uploads a video for review.
 *  `category` picks the contest: "creator" (Content Creators) or "fan" (Fan Videos). */
export async function submitVideo(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.fan?.id);
    if (!user) return res.status(404).json({ message: "Account not found" });
    if (!user.emailVerified) {
      return res.status(403).json({ message: "Please confirm your email before uploading." });
    }
    const b = req.body ?? {};
    if (!b.title) return res.status(400).json({ message: "Give your video a title" });

    const vf = (req.files as UploadedFiles | undefined)?.videoFile?.[0];
    if (!vf) return res.status(400).json({ message: "Upload a video file" });
    const videoUrl = (await uploadVideo(vf.buffer)).url;
    const posterFile = (req.files as UploadedFiles | undefined)?.poster?.[0];
    const poster = posterFile ? (await uploadBuffer(posterFile.buffer, "image")).url : undefined;

    const category = b.category === "creator" ? "creator" : "fan";
    const video = await Video.create({
      title: b.title,
      category,
      creator: user.name || (typeof b.creator === "string" ? b.creator : undefined),
      description: b.description,
      videoUrl,
      poster,
      status: "pending",
      submittedBy: user._id,
    });

    void sendNotification(
      `New ${category} video awaiting review: ${video.title}`,
      `From ${user.name || user.email} (${user.email})`
    );
    res.status(201).json({ ok: true, id: video._id, status: video.status });
  } catch (err) {
    next(err);
  }
}

/** POST /api/account/submissions/model — a user uploads a model profile for review. */
export async function submitModel(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.fan?.id);
    if (!user) return res.status(404).json({ message: "Account not found" });
    if (!user.emailVerified) {
      return res.status(403).json({ message: "Please confirm your email before uploading." });
    }
    const b = req.body ?? {};
    const name = String(b.name || user.name || "").trim();
    if (!name) return res.status(400).json({ message: "Add your model name" });

    const files = (req.files as UploadedFiles | undefined)?.photos ?? [];
    if (files.length === 0) return res.status(400).json({ message: "Add at least one photo" });
    const photos = (await Promise.all(files.map((f) => uploadBuffer(f.buffer, "image")))).map(
      (r) => r.url
    );

    const m = await ModelProfile.create({
      name,
      slug: await uniqueSlug(ModelProfile, b.slug || name),
      bio: b.bio,
      rateGhs: asNum(b.rateGhs, 2000),
      photos,
      status: "pending",
      submittedBy: user._id,
    });

    void sendNotification(
      `New model profile awaiting review: ${m.name}`,
      `From ${user.name || user.email} (${user.email})`
    );
    res.status(201).json({ ok: true, id: m._id, status: m.status });
  } catch (err) {
    next(err);
  }
}

/** GET /api/account/submissions/mine — the signed-in user's own submissions + status. */
export async function mySubmissions(req: Request, res: Response, next: NextFunction) {
  try {
    const uid = req.fan?.id;
    const [videos, models] = await Promise.all([
      Video.find({ submittedBy: uid }).sort({ createdAt: -1 }),
      ModelProfile.find({ submittedBy: uid }).sort({ createdAt: -1 }),
    ]);
    res.json({
      videos: videos.map((v) => ({
        id: String(v._id),
        title: v.title,
        category: v.category,
        status: v.status,
        createdAt: v.createdAt,
      })),
      models: models.map((m) => ({
        id: String(m._id),
        name: m.name,
        status: m.status,
        createdAt: m.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
}
