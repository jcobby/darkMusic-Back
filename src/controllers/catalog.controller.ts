import { Request, Response, NextFunction } from "express";
import fs from "fs";
import { Release } from "../models/Release";
import { Beat } from "../models/Beat";
import { MerchProduct } from "../models/MerchProduct";
import { publicRelease, publicBeat, publicMerch } from "../utils/serialize";
import { resolveStored, storedFileExists } from "../services/storage";

// ~30–60s of audio (byte cap; exact length is bitrate-dependent). Enough for a
// taste, never the full song — so paid tracks stay protected while fans preview.
const PREVIEW_BYTES = 1_300_000;

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

/** Streams a capped (~30s) preview of a release's MP3 — never the full file. */
export async function previewRelease(req: Request, res: Response, next: NextFunction) {
  try {
    const release = await Release.findOne({ slug: req.params.slug });
    if (!release || !release.audioKey || !storedFileExists("audio", release.audioKey)) {
      return res.status(404).json({ message: "Preview not available" });
    }
    const filePath = resolveStored("audio", release.audioKey);
    const size = fs.statSync(filePath).size;
    if (size <= 0) return res.status(404).json({ message: "Preview not available" });
    const end = Math.min(PREVIEW_BYTES, size) - 1;
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", String(end + 1));
    res.setHeader("Cache-Control", "public, max-age=3600");
    fs.createReadStream(filePath, { start: 0, end }).pipe(res);
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

/** Free MP3 download for a beat — no payment required. */
export async function downloadFreeBeat(req: Request, res: Response, next: NextFunction) {
  try {
    const beat = await Beat.findOne({ slug: req.params.slug });
    if (!beat || !beat.mp3FreeKey) {
      return res.status(404).json({ message: "Free download not available" });
    }
    if (!storedFileExists("beats", beat.mp3FreeKey)) {
      return res.status(404).json({ message: "File missing on server" });
    }
    const filePath = resolveStored("beats", beat.mp3FreeKey);
    res.download(filePath, `${beat.slug}.mp3`);
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
