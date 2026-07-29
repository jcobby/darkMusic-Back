import { Schema, model, Document } from "mongoose";

/** A content-creation video (promo / shout-out) shown on /videos and rated by fans. */
export interface IVideo extends Document {
  title: string;
  creator?: string; // the content creator who made it
  description?: string;
  videoUrl: string; // YouTube URL or a direct MP4 (e.g. Cloudinary)
  poster?: string; // thumbnail image filename/URL
  ratingSum: number;
  ratingCount: number;
  hidden: boolean;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const videoSchema = new Schema<IVideo>(
  {
    title: { type: String, required: true, trim: true },
    creator: { type: String, trim: true },
    description: { type: String, trim: true },
    videoUrl: { type: String, required: true, trim: true },
    poster: { type: String, trim: true },
    ratingSum: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    hidden: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Video = model<IVideo>("Video", videoSchema);
