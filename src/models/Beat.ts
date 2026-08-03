import { Schema, model, Document } from "mongoose";

/** A free beat: free MP3 download + paid high-quality WAV. */
export interface IBeat extends Document {
  title: string;
  slug: string;
  coverImage?: string;
  genre?: string;
  mp3FreeKey?: string; // stored MP3 filename (storage/beats) — free download
  wavKey?: string; // stored WAV filename — delivered after purchase
  wavPriceGhs: number;
  isFeatured: boolean;
  isWelcome: boolean; // auto-plays for first-time visitors
  hidden: boolean; // hidden from the public site (still usable as soundtrack, etc.)
  plays: number; // on-site plays — powers "Trending"
  freeDownloads: number; // free MP3 downloads
  wavDownloads: number; // paid WAV downloads (units sold)
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const beatSchema = new Schema<IBeat>(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    coverImage: { type: String, trim: true },
    genre: { type: String, trim: true },
    mp3FreeKey: { type: String, trim: true },
    wavKey: { type: String, trim: true },
    wavPriceGhs: { type: Number, default: 100, min: 0 },
    isFeatured: { type: Boolean, default: false },
    isWelcome: { type: Boolean, default: false },
    hidden: { type: Boolean, default: false },
    plays: { type: Number, default: 0 },
    freeDownloads: { type: Number, default: 0 },
    wavDownloads: { type: Number, default: 0 },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Beat = model<IBeat>("Beat", beatSchema);
