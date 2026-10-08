import { Schema, model, Document, Types } from "mongoose";

export type ModerationStatus = "pending" | "approved" | "rejected";

/** A model available for booking, shown on /models. */
export interface IModelProfile extends Document {
  name: string; // stage/model name
  slug: string;
  photos: string[]; // image URLs (first is the main shot)
  video?: string; // optional intro video URL
  bio?: string;
  isFeatured: boolean;
  hidden: boolean; // hidden from the public site
  order: number;
  status: ModerationStatus; // approved = live; pending/rejected hidden from the public
  submittedBy?: Types.ObjectId; // the model's own account (self-registered or linked by admin)

  // Public profile details
  location?: string;
  height?: string;
  experience?: string;
  categories: string[]; // shoot types they take
  languages: string[];
  rateGhs?: number; // starting rate
  availability?: string;
  instagram?: string; // handle, no @
  tiktok?: string; // handle, no @

  // Private — seen by DMY only (contact details reach a customer after payment)
  legalName?: string;
  phone?: string;
  email?: string;
  age?: number;
  weight?: string;
  termsAcceptedAt?: Date;
  termsVersion?: string;

  // Denormalized from completed-booking reviews
  ratingAvg: number;
  ratingCount: number;

  createdAt: Date;
  updatedAt: Date;
}

const modelProfileSchema = new Schema<IModelProfile>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    photos: { type: [String], default: [] },
    video: { type: String, trim: true },
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
    submittedBy: { type: Schema.Types.ObjectId, ref: "User", index: true },

    location: { type: String, trim: true },
    height: { type: String, trim: true },
    experience: { type: String, trim: true },
    categories: { type: [String], default: [] },
    languages: { type: [String], default: [] },
    rateGhs: { type: Number, min: 0 },
    availability: { type: String, trim: true },
    instagram: { type: String, trim: true },
    tiktok: { type: String, trim: true },

    legalName: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    age: { type: Number, min: 0 },
    weight: { type: String, trim: true },
    termsAcceptedAt: { type: Date },
    termsVersion: { type: String },

    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const ModelProfile = model<IModelProfile>("ModelProfile", modelProfileSchema);
