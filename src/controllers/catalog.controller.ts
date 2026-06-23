import { Request, Response, NextFunction } from "express";
import { Release } from "../models/Release";
import { Beat } from "../models/Beat";
import { MerchProduct } from "../models/MerchProduct";
import { publicRelease, publicBeat, publicMerch } from "../utils/serialize";
import { freeBeatUrl, previewUrl } from "../services/cloudinary";

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

/** Free MP3 download for a beat — redirects to the public Cloudinary file. */
export async function downloadFreeBeat(req: Request, res: Response, next: NextFunction) {
  try {
    const beat = await Beat.findOne({ slug: req.params.slug });
    if (!beat || !beat.mp3FreeKey) {
      return res.status(404).json({ message: "Free download not available" });
    }
    res.redirect(freeBeatUrl(beat.mp3FreeKey));
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
