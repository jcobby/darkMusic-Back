import { Schema, model, Document } from "mongoose";

/** A music release shown on /music. Streaming links + an optional paid MP3. */
export interface IRelease extends Document {
  title: string;
  slug: string;
  coverImage?: string; // filename under /uploads or an absolute URL
  spotifyUrl?: string;
  appleUrl?: string;
  youtubeUrl?: string;
  isFeatured: boolean;
  downloadable: boolean;
  priceGhs: number; // MP3 price when downloadable
  audioKey?: string; // stored MP3 filename (storage/audio) delivered after purchase
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const releaseSchema = new Schema<IRelease>(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    coverImage: { type: String, trim: true },
    spotifyUrl: { type: String, trim: true },
    appleUrl: { type: String, trim: true },
    youtubeUrl: { type: String, trim: true },
    isFeatured: { type: Boolean, default: false },
    downloadable: { type: Boolean, default: false },
    priceGhs: { type: Number, default: 10, min: 0 },
    audioKey: { type: String, trim: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Release = model<IRelease>("Release", releaseSchema);
