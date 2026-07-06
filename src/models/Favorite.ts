import { Schema, model, Document } from "mongoose";

/** A track (release or beat) a fan has saved to their favourites. */
export interface IFavorite extends Document {
  user: string; // User _id
  kind: "release" | "beat";
  refId: string;
  createdAt: Date;
}

const favoriteSchema = new Schema<IFavorite>(
  {
    user: { type: String, required: true, index: true },
    kind: { type: String, enum: ["release", "beat"], required: true },
    refId: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// One favourite per (fan, track).
favoriteSchema.index({ user: 1, kind: 1, refId: 1 }, { unique: true });

export const Favorite = model<IFavorite>("Favorite", favoriteSchema);
