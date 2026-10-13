import { Schema, model, Document, Types } from "mongoose";

export const MERCH_CATEGORIES = [
  "tshirt",
  "jersey",
  "hoodie",
  "cap",
  "socks",
  "wristband",
  "bandana",
  "book",
  "pen",
  "poster",
  "signed",
  "limited",
] as const;
export type MerchCategory = (typeof MERCH_CATEGORIES)[number];

/**
 * Optional auction on a product. While it's enabled the item can't be bought at
 * the fixed price — signed-in fans bid, and when `endsAt` passes the highest
 * bidder wins and pays their bid through the normal checkout.
 */
export interface IMerchAuction {
  enabled: boolean;
  startingBidGhs: number;
  minIncrementGhs: number;
  endsAt?: Date;
  // Current leader (denormalised from MerchBid so a bid can be checked atomically)
  highBidGhs?: number | null;
  highBidder?: Types.ObjectId | null;
  highBidderName?: string | null;
  highSize?: string | null;
  bidCount: number;
  closedAt?: Date | null; // when the result was announced
  paidAt?: Date | null; // when the winner paid
}

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
  auction: IMerchAuction;
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
    auction: {
      enabled: { type: Boolean, default: false },
      startingBidGhs: { type: Number, default: 0, min: 0 },
      minIncrementGhs: { type: Number, default: 10, min: 1 },
      endsAt: { type: Date },
      highBidGhs: { type: Number, default: null },
      highBidder: { type: Schema.Types.ObjectId, ref: "User", default: null },
      highBidderName: { type: String, default: null },
      highSize: { type: String, default: null },
      bidCount: { type: Number, default: 0 },
      closedAt: { type: Date, default: null },
      paidAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);
// The auction sweeper looks for enabled auctions whose end time has passed.
merchSchema.index({ "auction.enabled": 1, "auction.endsAt": 1 });

export const MerchProduct = model<IMerchProduct>("MerchProduct", merchSchema);
