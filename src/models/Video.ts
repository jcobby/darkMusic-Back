import { Schema, model, Document, Types } from "mongoose";

/** A content-creation video (promo / shout-out) shown on /videos and rated by fans. */
export type VideoCategory = "creator" | "fan" | "shorts";
export type ModerationStatus = "pending" | "approved" | "rejected";

export interface IVideo extends Document {
  title: string;
  category: VideoCategory; // which contest: content creators vs fans
  creator?: string; // the content creator who made it
  description?: string;
  videoUrl: string; // YouTube URL or a direct MP4 (e.g. Cloudinary)
  poster?: string; // thumbnail image filename/URL
  ratingSum: number;
  ratingCount: number;
  voteCount: number; // "best video" contest votes
  hidden: boolean;
  order: number;
  status: ModerationStatus; // approved = live; pending/rejected are hidden from the public
  submittedBy?: Types.ObjectId; // set when a fan/creator uploaded it (else admin-added)
  createdAt: Date;
  updatedAt: Date;
}

const videoSchema = new Schema<IVideo>(
  {
    title: { type: String, required: true, trim: true },
    category: { type: String, enum: ["creator", "fan", "shorts"], default: "creator", index: true },
    creator: { type: String, trim: true },
    description: { type: String, trim: true },
    videoUrl: { type: String, required: true, trim: true },
    poster: { type: String, trim: true },
    ratingSum: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    voteCount: { type: Number, default: 0 },
    hidden: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "approved",
      index: true,
    },
    submittedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export const Video = model<IVideo>("Video", videoSchema);
