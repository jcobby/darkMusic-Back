import { Request, Response, NextFunction } from "express";
import { ModelProfile } from "../models/ModelProfile";
import { ModelBooking } from "../models/ModelBooking";
import { publicModel } from "../utils/serialize";
import { sendNotification } from "../services/mailer";

// Public models exclude hidden items and anything awaiting review / rejected.
// (Admin-added models default to "approved"; legacy docs with no status also match.)
const visible = { hidden: { $ne: true }, status: { $nin: ["pending", "rejected"] } };
const isEmail = (v: unknown) => typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

/** GET /api/models — public list of bookable models. */
export async function listModels(req: Request, res: Response, next: NextFunction) {
  try {
    const filter: Record<string, unknown> = { ...visible };
    if (req.query.featured === "true") filter.isFeatured = true;
    const models = await ModelProfile.find(filter).sort({ order: 1, createdAt: -1 });
    res.json(models.map(publicModel));
  } catch (err) {
    next(err);
  }
}

/** GET /api/models/:slug — a single model. */
export async function getModel(req: Request, res: Response, next: NextFunction) {
  try {
    const m = await ModelProfile.findOne({ slug: req.params.slug, ...visible });
    if (!m) return res.status(404).json({ message: "Model not found" });
    res.json(publicModel(m));
  } catch (err) {
    next(err);
  }
}

/** POST /api/models/bookings — a client requests to book a model. */
export async function createBooking(req: Request, res: Response, next: NextFunction) {
  try {
    const b = req.body ?? {};
    if (!b.modelId) return res.status(400).json({ message: "Please choose a model" });
    if (!b.clientName || !isEmail(b.email)) {
      return res.status(400).json({ message: "Your name and a valid email are required" });
    }
    const modelDoc = await ModelProfile.findById(b.modelId);
    if (!modelDoc || modelDoc.hidden) {
      return res.status(404).json({ message: "Model not available" });
    }
    const booking = await ModelBooking.create({
      modelId: modelDoc._id,
      modelName: modelDoc.name,
      clientName: b.clientName,
      email: b.email,
      phone: b.phone,
      date: b.date,
      eventType: b.eventType,
      budget: b.budget,
      message: b.message,
    });

    void sendNotification(
      `New model booking request: ${modelDoc.name}`,
      JSON.stringify(booking.toObject(), null, 2)
    );

    res.status(201).json({ ok: true, id: booking._id });
  } catch (err) {
    next(err);
  }
}
