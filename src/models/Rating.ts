import { Schema, model, Document } from "mongoose";

/** A fan's 1–5 star rating for a video (one per fan per video). */
export interface IRating extends Document {
  user: string; // User _id
  video: string; // Video _id
  stars: number; // 1–5
  createdAt: Date;
  updatedAt: Date;
}

const ratingSchema = new Schema<IRating>(
  {
    user: { type: String, required: true, index: true },
    video: { type: String, required: true, index: true },
    stars: { type: Number, required: true, min: 1, max: 5 },
  },
  { timestamps: true }
);

// One rating per (fan, video).
ratingSchema.index({ user: 1, video: 1 }, { unique: true });

export const Rating = model<IRating>("Rating", ratingSchema);
