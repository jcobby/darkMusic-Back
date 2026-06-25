import { Schema, model, Document } from "mongoose";

export const MERCH_CATEGORIES = [
  "tshirt",
  "hoodie",
  "cap",
  "poster",
  "signed",
  "limited",
] as const;
export type MerchCategory = (typeof MERCH_CATEGORIES)[number];

/** A physical merch product shown on /merch. */
export interface IMerchProduct extends Document {
  name: string;
  slug: string;
  description?: string;
  images: string[]; // filenames under /uploads or absolute URLs
  category: MerchCategory;
  priceGhs: number;
  sizes: string[]; // e.g. ["S","M","L","XL"]; empty for one-size items
  stock: number;
  isLimited: boolean;
  isSigned: boolean;
  isFeatured: boolean;
  hidden: boolean; // hidden from the public site
  createdAt: Date;
  updatedAt: Date;
}

const merchSchema = new Schema<IMerchProduct>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    description: { type: String, trim: true },
    images: { type: [String], default: [] },
    category: { type: String, enum: MERCH_CATEGORIES, required: true },
    priceGhs: { type: Number, required: true, min: 0 },
    sizes: { type: [String], default: [] },
    stock: { type: Number, default: 0, min: 0 },
    isLimited: { type: Boolean, default: false },
    isSigned: { type: Boolean, default: false },
    isFeatured: { type: Boolean, default: false },
    hidden: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const MerchProduct = model<IMerchProduct>("MerchProduct", merchSchema);
