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
  "worn", // worn on set — sold by auction
] as const;
export type MerchCategory = (typeof MERCH_CATEGORIES)[number];

/** "shop" = the fixed-price store (/merch); "worn" = Worn on Set auction pieces (/worn-on-set). */
export type MerchKind = "shop" | "worn";

/** An auction's clock starts with its first bid and runs this many days. */
export const AUCTION_RUN_DAYS = 14;

/**
 * Auction on a product. While it's enabled the item can't be bought at a fixed
 * price — signed-in fans bid. There's no clock until the first bid, which sets
 * `endsAt` to AUCTION_RUN_DAYS later. When `endsAt` passes the highest bidder wins
 * and has `payWindowHours` to pay. If they don't, it's offered to the next
 * highest bidder (anyone in `lapsed` is skipped), or marked unsold to relist.
 */
export interface IMerchAuction {
  enabled: boolean;
  startingBidGhs: number;
  minIncrementGhs: number;
  endsAt?: Date; // set by the first bid (ignored before then)
  payWindowHours: number;
  // Current leader / winner (denormalised from MerchBid so a bid can be checked atomically)
  highBidGhs?: number | null;
  highBidder?: Types.ObjectId | null;
  highBidderName?: string | null;
  highSize?: string | null;
  bidCount: number;
  closedAt?: Date | null; // when the result was announced
  payBy?: Date | null; // the current winner must pay before this
  lapsed: Types.ObjectId[]; // winners who didn't pay in time
  unsold?: boolean; // nobody left to offer it to — relist it
  paidAt?: Date | null; // when the winner paid
}

/** A physical product: shop merch, or a worn-on-set auction piece. */
export interface IMerchProduct extends Document {
  name: string;
  slug: string;
  kind: MerchKind;
  description?: string;
  condition?: string; // worn pieces: condition notes
  wornIn?: string; // worn pieces: e.g. "It's Working video"
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
    kind: { type: String, enum: ["shop", "worn"], default: "shop", index: true },
    description: { type: String, trim: true },
    condition: { type: String, trim: true },
    wornIn: { type: String, trim: true },
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
      payWindowHours: { type: Number, default: 48, min: 1 },
      highBidGhs: { type: Number, default: null },
      highBidder: { type: Schema.Types.ObjectId, ref: "User", default: null },
      highBidderName: { type: String, default: null },
      highSize: { type: String, default: null },
      bidCount: { type: Number, default: 0 },
      closedAt: { type: Date, default: null },
      payBy: { type: Date, default: null },
      lapsed: { type: [Schema.Types.ObjectId], default: [] },
      unsold: { type: Boolean, default: false },
      paidAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);
// The auction sweeper looks for enabled auctions whose end time / payment window has passed.
merchSchema.index({ "auction.enabled": 1, "auction.endsAt": 1 });
merchSchema.index({ "auction.enabled": 1, "auction.payBy": 1 });

export const MerchProduct = model<IMerchProduct>("MerchProduct", merchSchema);
