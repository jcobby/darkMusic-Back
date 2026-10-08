import { Request, Response, NextFunction } from "express";
import { ModelProfile } from "../models/ModelProfile";
import { publicModel } from "../utils/serialize";
import { VISIBLE_MODEL, publicReviews } from "./bookings.controller";

/** GET /api/models — public list of bookable models. */
export async function listModels(req: Request, res: Response, next: NextFunction) {
  try {
    const filter: Record<string, unknown> = { ...VISIBLE_MODEL };
    if (req.query.featured === "true") filter.isFeatured = true;
    const models = await ModelProfile.find(filter).sort({ order: 1, createdAt: -1 });
    res.json(models.map(publicModel));
  } catch (err) {
    next(err);
  }
}

/** GET /api/models/:slug — a single model, with their latest reviews. */
export async function getModel(req: Request, res: Response, next: NextFunction) {
  try {
    const m = await ModelProfile.findOne({ slug: req.params.slug, ...VISIBLE_MODEL });
    if (!m) return res.status(404).json({ message: "Model not found" });
    res.json({ ...publicModel(m), reviews: await publicReviews(m._id) });
  } catch (err) {
    next(err);
  }
}
