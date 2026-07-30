import { Schema, model, Document } from "mongoose";

/** A fan's single "best video" contest vote. One per fan (they pick one #1). */
export interface IVote extends Document {
  user: string; // User _id — unique, so each fan has exactly one vote
  video: string; // Video _id they voted for
  createdAt: Date;
  updatedAt: Date;
}

const voteSchema = new Schema<IVote>(
  {
    user: { type: String, required: true, unique: true, index: true },
    video: { type: String, required: true, index: true },
  },
  { timestamps: true }
);

export const Vote = model<IVote>("Vote", voteSchema);
