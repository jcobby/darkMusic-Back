import { Request, Response, NextFunction } from "express";
import { Model } from "mongoose";
import { User } from "../models/User";
import { Video } from "../models/Video";
import { ModelProfile } from "../models/ModelProfile";
import { slugify } from "../utils/slug";
import { UploadedFiles } from "../services/upload";
import { uploadBuffer, uploadVideo } from "../services/cloudinary";
import { sendNotification } from "../services/mailer";
import { MODELS_MARKET, MODEL_DECLARATIONS } from "../config/modelsMarket";
import { readModelFields, asList, ALL_MODEL_FIELDS, ModelFieldKey } from "../utils/modelFields";

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

// Registration can't go through without these (besides name, photos and declarations).
const REQUIRED: [ModelFieldKey, string][] = [
  ["legalName", "Add your full legal name"],
  ["phone", "Add your phone number"],
  ["location", "Add your location"],
  ["age", "Add your age"],
  ["height", "Add your height"],
  ["weight", "Add your weight"],
  ["categories", "Pick at least one shoot type"],
  ["rateGhs", "Set your starting rate"],
  ["availability", "Tell clients when you're available"],
];

/** POST /api/account/submissions/model — a model registers; DMY reviews before listing. */
export async function submitModel(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.fan?.id);
    if (!user) return res.status(404).json({ message: "Account not found" });
    if (!user.emailVerified) {
      return res.status(403).json({ message: "Please confirm your email before uploading." });
    }
    const existing = await ModelProfile.findOne({
      submittedBy: user._id,
      status: { $in: ["pending", "approved"] },
    });
    if (existing) {
      return res.status(409).json({
        message:
          existing.status === "pending"
            ? "Your model profile is already waiting for review"
            : "You already have a live model profile — update it from your model dashboard",
      });
    }

    const b = req.body ?? {};
    const name = String(b.name || "").trim().slice(0, 80);
    if (!name) return res.status(400).json({ message: "Add your stage / model name" });

    const agreed = new Set(asList(b.agree));
    if (MODEL_DECLARATIONS.some((d) => !agreed.has(d))) {
      return res.status(400).json({ message: "Tick every declaration to register" });
    }

    const { fields, error } = readModelFields(b, ALL_MODEL_FIELDS);
    if (error) return res.status(400).json({ message: error });
    const missing = REQUIRED.find(([key]) => {
      const v = fields[key];
      return v === undefined || (Array.isArray(v) && v.length === 0);
    });
    if (missing) return res.status(400).json({ message: missing[1] });

    const files = (req.files as UploadedFiles | undefined)?.photos ?? [];
    if (files.length < MODELS_MARKET.minPhotos) {
      return res
        .status(400)
        .json({ message: `Add at least ${MODELS_MARKET.minPhotos} portfolio photos` });
    }
    if (files.some((f) => !f.mimetype.startsWith("image/"))) {
      return res.status(400).json({ message: "Portfolio photos must be images" });
    }
    const videoFile = (req.files as UploadedFiles | undefined)?.video?.[0];
    if (videoFile && !videoFile.mimetype.startsWith("video/")) {
      return res.status(400).json({ message: "The intro video must be a video file" });
    }

    const photos = (await Promise.all(files.map((f) => uploadBuffer(f.buffer, "image")))).map(
      (r) => r.url
    );
    const video = videoFile ? (await uploadVideo(videoFile.buffer)).url : undefined;

    const m = await ModelProfile.create({
      ...fields,
      name,
      slug: await uniqueSlug(ModelProfile, name),
      email: fields.email || user.email,
      photos,
      video,
      status: "pending",
      submittedBy: user._id,
      termsAcceptedAt: new Date(),
      termsVersion: MODELS_MARKET.termsVersion,
    });

    void sendNotification(
      `New model registration awaiting review: ${m.name}`,
      [
        `Account: ${user.name || "—"} (${user.email})`,
        `Legal name: ${m.legalName}`,
        `Phone: ${m.phone}`,
        `Location: ${m.location}`,
        `Age: ${m.age} · Height: ${m.height} · Weight: ${m.weight}`,
        `Shoot types: ${m.categories.join(", ")}`,
        `Starting rate: GH₵${m.rateGhs?.toLocaleString("en-US")}`,
        `Availability: ${m.availability}`,
        m.experience ? `Experience: ${m.experience}` : "",
        `Photos: ${m.photos.length}${m.video ? " + intro video" : ""}`,
        "",
        "Review it in the admin ★ Review tab.",
      ]
        .filter((line) => line !== "")
        .join("\n")
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
