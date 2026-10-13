import { Schema, model, Document } from "mongoose";

/** A behind-the-scenes photo uploaded in the admin, shown on /behind-the-scenes. */
export interface IGalleryPhoto extends Document {
  image: string; // Cloudinary URL
  caption?: string;
  shoot?: string; // groups photos, e.g. "It's Working video"
  order: number;
  hidden: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const galleryPhotoSchema = new Schema<IGalleryPhoto>(
  {
    image: { type: String, required: true },
    caption: { type: String, trim: true },
    shoot: { type: String, trim: true },
    order: { type: Number, default: 0 },
    hidden: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const GalleryPhoto = model<IGalleryPhoto>("GalleryPhoto", galleryPhotoSchema);
