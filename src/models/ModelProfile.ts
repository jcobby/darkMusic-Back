import { Schema, model, Document, Types } from "mongoose";

export type ModerationStatus = "pending" | "approved" | "rejected";

/** A model available for booking, shown on /models. */
export interface IModelProfile extends Document {
  name: string;
  slug: string;
  photos: string[]; // image URLs (first is the main shot)
  bio?: string;
  isFeatured: boolean;
  hidden: boolean; // hidden from the public site
  order: number;
  status: ModerationStatus; // approved = live; pending/rejected hidden from the public
  submittedBy?: Types.ObjectId; // set when a model self-registered (else admin-added)
  createdAt: Date;
  updatedAt: Date;
}

const modelProfileSchema = new Schema<IModelProfile>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    photos: { type: [String], default: [] },
    bio: { type: String, trim: true },
    isFeatured: { type: Boolean, default: false },
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

export const ModelProfile = model<IModelProfile>("ModelProfile", modelProfileSchema);
