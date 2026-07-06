import { Schema, model, Document } from "mongoose";

/** A post on the public Fan Wall (message + optional photo, e.g. wearing merch). */
export interface IFanPost extends Document {
  user: string; // User _id (author)
  authorName: string;
  body: string;
  image?: string; // Cloudinary URL
  likedBy: string[]; // User ids who liked it
  createdAt: Date;
}

const fanPostSchema = new Schema<IFanPost>(
  {
    user: { type: String, required: true, index: true },
    authorName: { type: String, required: true, trim: true },
    body: { type: String, trim: true, maxlength: 500, default: "" },
    image: { type: String, trim: true },
    likedBy: { type: [String], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const FanPost = model<IFanPost>("FanPost", fanPostSchema);
