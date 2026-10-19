import { Schema, model, Document, Types } from "mongoose";

/**
 * A note from the site's Feedback button: what someone thinks or what went wrong,
 * with an optional 1–5 rating and the page they sent it from.
 */
export interface IFeedback extends Document {
  user?: Types.ObjectId | null; // signed-in fan, if any
  name?: string;
  email?: string; // to reply to (a guest may leave one)
  rating?: number | null; // 1–5, optional
  message: string;
  page: string; // path it was sent from, e.g. /games/beat-breaker
  device: "phone" | "tablet" | "desktop";
  userAgent?: string;
  status: "new" | "done";
  notifiedAt?: Date | null; // included in an email to DMY
  createdAt: Date;
  updatedAt: Date;
}

const feedbackSchema = new Schema<IFeedback>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    name: { type: String, trim: true, maxlength: 80 },
    email: { type: String, trim: true, lowercase: true, maxlength: 120 },
    rating: { type: Number, min: 1, max: 5, default: null },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    page: { type: String, trim: true, maxlength: 300, default: "/" },
    device: { type: String, enum: ["phone", "tablet", "desktop"], default: "desktop" },
    userAgent: { type: String, trim: true, maxlength: 300 },
    status: { type: String, enum: ["new", "done"], default: "new", index: true },
    notifiedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

export const Feedback = model<IFeedback>("Feedback", feedbackSchema);
