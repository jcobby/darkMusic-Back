import { Request, Response, NextFunction } from "express";
import { Release } from "../models/Release";
import { Beat } from "../models/Beat";
import { MerchProduct } from "../models/MerchProduct";
import { publicRelease, publicBeat, publicMerch } from "../utils/serialize";
import { imageUrl } from "../utils/media";
import { freeBeatStreamUrl, freeBeatDownloadUrl, previewUrl } from "../services/cloudinary";

// ----- Releases -----
export async function listReleases(req: Request, res: Response, next: NextFunction) {
  try {
    const filter = req.query.featured === "true" ? { isFeatured: true } : {};
    const releases = await Release.find(filter).sort({ order: 1, createdAt: -1 });
    res.json(releases.map(publicRelease));
  } catch (err) {
    next(err);
  }
}

export async function getRelease(req: Request, res: Response, next: NextFunction) {
  try {
    const release = await Release.findOne({ slug: req.params.slug });
    if (!release) return res.status(404).json({ message: "Release not found" });
    res.json(publicRelease(release));
  } catch (err) {
    next(err);
  }
}

/** The release OR beat chosen to auto-play for first-time visitors (or null). */
export async function getWelcomeTrack(_req: Request, res: Response, next: NextFunction) {
  try {
    const release = await Release.findOne({ isWelcome: true }).sort({ updatedAt: -1 });
    if (release) {
      return res.json({
        kind: "release",
        id: String(release._id),
        title: release.title,
        slug: release.slug,
        coverImage: imageUrl(release.coverImage),
        spotifyUrl: release.spotifyUrl || null,
        hasPreview: Boolean(release.audioKey),
        hasFreeMp3: false,
      });
    }
    const beat = await Beat.findOne({ isWelcome: true }).sort({ updatedAt: -1 });
    if (beat) {
      return res.json({
        kind: "beat",
        id: String(beat._id),
        title: beat.title,
        slug: beat.slug,
        coverImage: imageUrl(beat.coverImage),
        spotifyUrl: null,
        hasPreview: false,
        hasFreeMp3: Boolean(beat.mp3FreeKey),
      });
    }
    res.json(null);
  } catch (err) {
    next(err);
  }
}

/** Redirects to a signed ~45s Cloudinary preview clip — never the full file. */
export async function previewRelease(req: Request, res: Response, next: NextFunction) {
  try {
    const release = await Release.findOne({ slug: req.params.slug });
    if (!release || !release.audioKey) {
      return res.status(404).json({ message: "Preview not available" });
    }
    res.redirect(previewUrl(release.audioKey));
  } catch (err) {
    next(err);
  }
}

// ----- Beats -----
export async function listBeats(req: Request, res: Response, next: NextFunction) {
  try {
    const filter = req.query.featured === "true" ? { isFeatured: true } : {};
    const beats = await Beat.find(filter).sort({ order: 1, createdAt: -1 });
    res.json(beats.map(publicBeat));
  } catch (err) {
    next(err);
  }
}

export async function getBeat(req: Request, res: Response, next: NextFunction) {
  try {
    const beat = await Beat.findOne({ slug: req.params.slug });
    if (!beat) return res.status(404).json({ message: "Beat not found" });
    res.json(publicBeat(beat));
  } catch (err) {
    next(err);
  }
}

/**
 * Free beat MP3 — redirects to Cloudinary. Inline (streamable) by default so it
 * plays in the audio player; `?download=1` forces a file download.
 */
export async function downloadFreeBeat(req: Request, res: Response, next: NextFunction) {
  try {
    const beat = await Beat.findOne({ slug: req.params.slug });
    if (!beat || !beat.mp3FreeKey) {
      return res.status(404).json({ message: "Free download not available" });
    }
    const url = req.query.download
      ? freeBeatDownloadUrl(beat.mp3FreeKey)
      : freeBeatStreamUrl(beat.mp3FreeKey);
    res.redirect(url);
  } catch (err) {
    next(err);
  }
}

// ----- Merch -----
export async function listMerch(req: Request, res: Response, next: NextFunction) {
  try {
    const filter = req.query.featured === "true" ? { isFeatured: true } : {};
    const merch = await MerchProduct.find(filter).sort({ createdAt: -1 });
    res.json(merch.map(publicMerch));
  } catch (err) {
    next(err);
  }
}

export async function getMerch(req: Request, res: Response, next: NextFunction) {
  try {
    const product = await MerchProduct.findOne({ slug: req.params.slug });
    if (!product) return res.status(404).json({ message: "Product not found" });
    res.json(publicMerch(product));
  } catch (err) {
    next(err);
  }
}
