import { Request, Response, NextFunction } from "express";
import { Release } from "../models/Release";
import { Beat } from "../models/Beat";
import { MerchProduct } from "../models/MerchProduct";
import { Inquiry } from "../models/Inquiry";
import { Order } from "../models/Order";
import { slugify } from "../utils/slug";
import { UploadedFiles } from "../services/upload";
import { uploadBuffer, UploadKind } from "../services/cloudinary";

// ---------- helpers ----------
const asBool = (v: unknown) => v === true || v === "true" || v === "on" || v === "1";
const asNum = (v: unknown, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const asList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim()) return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
};

async function uniqueSlug(
  model: { exists: (q: Record<string, unknown>) => Promise<unknown> },
  base: string,
  currentId?: string
): Promise<string> {
  const root = slugify(base) || "item";
  let slug = root;
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await model.exists({ slug, ...(currentId ? { _id: { $ne: currentId } } : {}) })) {
    slug = `${root}-${++n}`;
  }
  return slug;
}

/** Upload one file field to Cloudinary; returns its URL (image) or public_id (audio). */
async function uploadField(
  req: Request,
  field: string,
  kind: UploadKind
): Promise<string | undefined> {
  const f = (req.files as UploadedFiles | undefined)?.[field]?.[0];
  if (!f) return undefined;
  const r = await uploadBuffer(f.buffer, kind);
  return kind === "image" ? r.url : r.publicId;
}

/** Upload many image files (merch gallery); returns their URLs. */
async function uploadMany(req: Request, field: string): Promise<string[]> {
  const list = (req.files as UploadedFiles | undefined)?.[field] ?? [];
  const results = await Promise.all(list.map((f) => uploadBuffer(f.buffer, "image")));
  return results.map((r) => r.url);
}

/** Make this release/beat the sole welcome track — clears the flag everywhere else. */
async function makeSoleWelcome(kind: "release" | "beat", id: unknown) {
  if (kind === "release") {
    await Release.updateMany({ _id: { $ne: id } }, { $set: { isWelcome: false } });
    await Beat.updateMany({}, { $set: { isWelcome: false } });
  } else {
    await Beat.updateMany({ _id: { $ne: id } }, { $set: { isWelcome: false } });
    await Release.updateMany({}, { $set: { isWelcome: false } });
  }
}

// ---------- Releases ----------
export async function adminListReleases(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await Release.find().sort({ order: 1, createdAt: -1 }));
  } catch (err) {
    next(err);
  }
}

export async function createRelease(req: Request, res: Response, next: NextFunction) {
  try {
    const b = req.body ?? {};
    if (!b.title) return res.status(400).json({ message: "Title is required" });
    const release = await Release.create({
      title: b.title,
      slug: await uniqueSlug(Release, b.slug || b.title),
      spotifyUrl: b.spotifyUrl,
      appleUrl: b.appleUrl,
      youtubeUrl: b.youtubeUrl,
      isFeatured: asBool(b.isFeatured),
      isWelcome: asBool(b.isWelcome),
      downloadable: asBool(b.downloadable),
      priceGhs: asNum(b.priceGhs, 10),
      order: asNum(b.order, 0),
      coverImage: await uploadField(req, "cover", "image"),
      audioKey: await uploadField(req, "audio", "audioPrivate"),
    });
    if (release.isWelcome) await makeSoleWelcome("release", release._id);
    res.status(201).json(release);
  } catch (err) {
    next(err);
  }
}

export async function updateRelease(req: Request, res: Response, next: NextFunction) {
  try {
    const release = await Release.findById(req.params.id);
    if (!release) return res.status(404).json({ message: "Release not found" });
    const b = req.body ?? {};
    if (b.title) release.title = b.title;
    if (b.slug) release.slug = await uniqueSlug(Release, b.slug, String(release._id));
    if (b.spotifyUrl !== undefined) release.spotifyUrl = b.spotifyUrl;
    if (b.appleUrl !== undefined) release.appleUrl = b.appleUrl;
    if (b.youtubeUrl !== undefined) release.youtubeUrl = b.youtubeUrl;
    if (b.isFeatured !== undefined) release.isFeatured = asBool(b.isFeatured);
    if (b.isWelcome !== undefined) release.isWelcome = asBool(b.isWelcome);
    if (b.downloadable !== undefined) release.downloadable = asBool(b.downloadable);
    if (b.priceGhs !== undefined) release.priceGhs = asNum(b.priceGhs, release.priceGhs);
    if (b.order !== undefined) release.order = asNum(b.order, release.order);
    const cover = await uploadField(req, "cover", "image");
    const audio = await uploadField(req, "audio", "audioPrivate");
    if (cover) release.coverImage = cover;
    if (audio) release.audioKey = audio;
    await release.save();
    if (release.isWelcome) await makeSoleWelcome("release", release._id);
    res.json(release);
  } catch (err) {
    next(err);
  }
}

export async function deleteRelease(req: Request, res: Response, next: NextFunction) {
  try {
    const r = await Release.findByIdAndDelete(req.params.id);
    if (!r) return res.status(404).json({ message: "Release not found" });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// ---------- Beats ----------
export async function adminListBeats(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await Beat.find().sort({ order: 1, createdAt: -1 }));
  } catch (err) {
    next(err);
  }
}

export async function createBeat(req: Request, res: Response, next: NextFunction) {
  try {
    const b = req.body ?? {};
    if (!b.title) return res.status(400).json({ message: "Title is required" });
    const beat = await Beat.create({
      title: b.title,
      slug: await uniqueSlug(Beat, b.slug || b.title),
      genre: b.genre,
      wavPriceGhs: asNum(b.wavPriceGhs, 100),
      isFeatured: asBool(b.isFeatured),
      isWelcome: asBool(b.isWelcome),
      order: asNum(b.order, 0),
      coverImage: await uploadField(req, "cover", "image"),
      mp3FreeKey: await uploadField(req, "mp3Free", "audioPublic"),
      wavKey: await uploadField(req, "wav", "audioPrivate"),
    });
    if (beat.isWelcome) await makeSoleWelcome("beat", beat._id);
    res.status(201).json(beat);
  } catch (err) {
    next(err);
  }
}

export async function updateBeat(req: Request, res: Response, next: NextFunction) {
  try {
    const beat = await Beat.findById(req.params.id);
    if (!beat) return res.status(404).json({ message: "Beat not found" });
    const b = req.body ?? {};
    if (b.title) beat.title = b.title;
    if (b.slug) beat.slug = await uniqueSlug(Beat, b.slug, String(beat._id));
    if (b.genre !== undefined) beat.genre = b.genre;
    if (b.wavPriceGhs !== undefined) beat.wavPriceGhs = asNum(b.wavPriceGhs, beat.wavPriceGhs);
    if (b.isFeatured !== undefined) beat.isFeatured = asBool(b.isFeatured);
    if (b.isWelcome !== undefined) beat.isWelcome = asBool(b.isWelcome);
    if (b.order !== undefined) beat.order = asNum(b.order, beat.order);
    const cover = await uploadField(req, "cover", "image");
    const mp3 = await uploadField(req, "mp3Free", "audioPublic");
    const wav = await uploadField(req, "wav", "audioPrivate");
    if (cover) beat.coverImage = cover;
    if (mp3) beat.mp3FreeKey = mp3;
    if (wav) beat.wavKey = wav;
    await beat.save();
    if (beat.isWelcome) await makeSoleWelcome("beat", beat._id);
    res.json(beat);
  } catch (err) {
    next(err);
  }
}

export async function deleteBeat(req: Request, res: Response, next: NextFunction) {
  try {
    const b = await Beat.findByIdAndDelete(req.params.id);
    if (!b) return res.status(404).json({ message: "Beat not found" });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// ---------- Merch ----------
export async function adminListMerch(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await MerchProduct.find().sort({ createdAt: -1 }));
  } catch (err) {
    next(err);
  }
}

export async function createMerch(req: Request, res: Response, next: NextFunction) {
  try {
    const b = req.body ?? {};
    if (!b.name) return res.status(400).json({ message: "Name is required" });
    const imgs = await uploadMany(req, "images");
    const product = await MerchProduct.create({
      name: b.name,
      slug: await uniqueSlug(MerchProduct, b.slug || b.name),
      description: b.description,
      category: b.category || "tshirt",
      priceGhs: asNum(b.priceGhs, 0),
      sizes: asList(b.sizes),
      stock: asNum(b.stock, 0),
      isLimited: asBool(b.isLimited),
      isSigned: asBool(b.isSigned),
      isFeatured: asBool(b.isFeatured),
      images: imgs,
    });
    res.status(201).json(product);
  } catch (err) {
    next(err);
  }
}

export async function updateMerch(req: Request, res: Response, next: NextFunction) {
  try {
    const product = await MerchProduct.findById(req.params.id);
    if (!product) return res.status(404).json({ message: "Product not found" });
    const b = req.body ?? {};
    if (b.name) product.name = b.name;
    if (b.slug) product.slug = await uniqueSlug(MerchProduct, b.slug, String(product._id));
    if (b.description !== undefined) product.description = b.description;
    if (b.category) product.category = b.category;
    if (b.priceGhs !== undefined) product.priceGhs = asNum(b.priceGhs, product.priceGhs);
    if (b.sizes !== undefined) product.sizes = asList(b.sizes);
    if (b.stock !== undefined) product.stock = asNum(b.stock, product.stock);
    if (b.isLimited !== undefined) product.isLimited = asBool(b.isLimited);
    if (b.isSigned !== undefined) product.isSigned = asBool(b.isSigned);
    if (b.isFeatured !== undefined) product.isFeatured = asBool(b.isFeatured);
    const newImgs = await uploadMany(req, "images");
    if (newImgs.length) product.images = [...product.images, ...newImgs];
    await product.save();
    res.json(product);
  } catch (err) {
    next(err);
  }
}

export async function deleteMerch(req: Request, res: Response, next: NextFunction) {
  try {
    const m = await MerchProduct.findByIdAndDelete(req.params.id);
    if (!m) return res.status(404).json({ message: "Product not found" });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// ---------- Inquiries & Orders ----------
export async function adminListInquiries(req: Request, res: Response, next: NextFunction) {
  try {
    const filter = req.query.type ? { type: req.query.type } : {};
    res.json(await Inquiry.find(filter).sort({ createdAt: -1 }));
  } catch (err) {
    next(err);
  }
}

export async function updateInquiry(req: Request, res: Response, next: NextFunction) {
  try {
    const inquiry = await Inquiry.findByIdAndUpdate(
      req.params.id,
      { status: req.body?.status },
      { new: true }
    );
    if (!inquiry) return res.status(404).json({ message: "Inquiry not found" });
    res.json(inquiry);
  } catch (err) {
    next(err);
  }
}

export async function adminListOrders(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await Order.find().sort({ createdAt: -1 }).limit(200));
  } catch (err) {
    next(err);
  }
}
