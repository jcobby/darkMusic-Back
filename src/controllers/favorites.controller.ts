import { Request, Response, NextFunction } from "express";
import { Favorite } from "../models/Favorite";
import { Release } from "../models/Release";
import { Beat } from "../models/Beat";
import { imageUrl } from "../utils/media";

const isKind = (v: unknown): v is "release" | "beat" => v === "release" || v === "beat";

/** GET /api/account/favorites — the fan's saved tracks, enriched for display. */
export async function listFavorites(req: Request, res: Response, next: NextFunction) {
  try {
    const favs = await Favorite.find({ user: req.fan!.id }).sort({ createdAt: -1 });
    const items = await Promise.all(
      favs.map(async (f) => {
        if (f.kind === "release") {
          const r = await Release.findById(f.refId);
          if (!r || r.hidden) return null;
          return { kind: "release", refId: String(r._id), title: r.title, slug: r.slug, coverImage: imageUrl(r.coverImage) };
        }
        const b = await Beat.findById(f.refId);
        if (!b || b.hidden) return null;
        return { kind: "beat", refId: String(b._id), title: b.title, slug: b.slug, coverImage: imageUrl(b.coverImage) };
      })
    );
    res.json(items.filter(Boolean));
  } catch (err) {
    next(err);
  }
}

/** POST /api/account/favorites — save a track (idempotent). */
export async function addFavorite(req: Request, res: Response, next: NextFunction) {
  try {
    const { kind, refId } = req.body ?? {};
    if (!isKind(kind) || typeof refId !== "string" || !refId) {
      return res.status(400).json({ message: "Invalid favourite" });
    }
    await Favorite.updateOne(
      { user: req.fan!.id, kind, refId },
      { $setOnInsert: { user: req.fan!.id, kind, refId } },
      { upsert: true }
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/account/favorites/:kind/:refId — remove a saved track. */
export async function removeFavorite(req: Request, res: Response, next: NextFunction) {
  try {
    const { kind, refId } = req.params;
    await Favorite.deleteOne({ user: req.fan!.id, kind, refId });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
