import { Schema, model, Document } from "mongoose";

/** A fan's "best video" vote — one per fan PER contest category (creator/fan). */
export interface IVote extends Document {
  user: string; // User _id
  category: "creator" | "fan"; // which contest this vote belongs to
  video: string; // Video _id they voted for
  createdAt: Date;
  updatedAt: Date;
}

const voteSchema = new Schema<IVote>(
  {
    user: { type: String, required: true, index: true },
    category: { type: String, enum: ["creator", "fan"], required: true },
    video: { type: String, required: true, index: true },
  },
  { timestamps: true }
);

// One vote per fan per contest category.
voteSchema.index({ user: 1, category: 1 }, { unique: true });

export const Vote = model<IVote>("Vote", voteSchema);
