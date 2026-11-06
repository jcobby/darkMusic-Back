import { Schema, model, Document, Types } from "mongoose";
import { MOMO_NETWORKS, type MomoNetwork } from "./Wallet";

/**
 * The Lenko Army promoter program (services/promoter): a member sends their Ghana Card
 * (number + photo, checked by DMY), then clicks on their link (darkmusicyard.com/r/<referral
 * code>) count each month towards a cash reward — paid once the card is approved.
 */
export type LinkKind = "device" | "phone" | "momo";
export type CardStatus = "pending" | "approved" | "rejected";
export interface IPromoter extends Document {
  user: Types.ObjectId;
  // Their Ghana Card — one card, one account (so the rewards are Ghana only)
  card?: {
    hash: string; // HMAC of the card number: tells if it's on another account, without keeping the number
    masked: string; // "GHA-•••••6789-0", for DMY to compare with the photo
    photo?: { id: string; format: string }; // private Cloudinary image — deleted once DMY decides
    status: CardStatus;
    note?: string; // why DMY turned it down
    submittedAt: Date;
    reviewedAt?: Date;
  };
  status: "active" | "disqualified";
  reason?: string; // why they're disqualified
  manual?: boolean; // DMY disqualified them by hand — the duplicate check doesn't lift it
  links: { kind: LinkKind; other: Types.ObjectId; at: Date }[]; // other accounts that look like the same person
  cleared: Types.ObjectId[]; // …ones DMY checked and allowed
  momo?: { network: MomoNetwork; number: string; accountName: string }; // where rewards are paid
  createdAt: Date;
  updatedAt: Date;
}

const promoterSchema = new Schema<IPromoter>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    card: {
      hash: { type: String },
      masked: { type: String },
      photo: { id: { type: String }, format: { type: String } },
      status: { type: String, enum: ["pending", "approved", "rejected"] },
      note: { type: String },
      submittedAt: { type: Date },
      reviewedAt: { type: Date },
    },
    status: { type: String, enum: ["active", "disqualified"], default: "active" },
    reason: { type: String },
    manual: { type: Boolean },
    links: [
      {
        _id: false,
        kind: { type: String, enum: ["device", "phone", "momo"], required: true },
        other: { type: Schema.Types.ObjectId, ref: "User", required: true },
        at: { type: Date, required: true },
      },
    ],
    cleared: [{ type: Schema.Types.ObjectId, ref: "User" }],
    momo: {
      network: { type: String, enum: MOMO_NETWORKS },
      number: { type: String, index: true },
      accountName: { type: String },
    },
  },
  { timestamps: true }
);
// One Ghana Card, one account. (Until 2026-11 members verified a phone by SMS; that index goes — see syncIndexes at startup.)
promoterSchema.index({ "card.hash": 1 }, { name: "one_card_one_account", unique: true, partialFilterExpression: { "card.hash": { $type: "string" } } });
promoterSchema.index({ "card.status": 1 });
export const Promoter = model<IPromoter>("Promoter", promoterSchema);

/** One counted click: a visitor (by browser id) counts once per link per month. Kept 4 months. */
export interface IPromoClick extends Document {
  promoter: Types.ObjectId; // the member's user id
  month: string; // YYYY-MM (Ghana time = UTC)
  day: string; // YYYY-MM-DD
  visitor: string; // sha256 of the visitor's browser id
  ip: string; // sha256 of their IP address
  at: Date;
}
const promoClickSchema = new Schema<IPromoClick>({
  promoter: { type: Schema.Types.ObjectId, ref: "User", required: true },
  month: { type: String, required: true },
  day: { type: String, required: true },
  visitor: { type: String, required: true },
  ip: { type: String, required: true },
  at: { type: Date, required: true },
});
promoClickSchema.index({ promoter: 1, month: 1, visitor: 1 }, { unique: true });
promoClickSchema.index({ promoter: 1, day: 1, ip: 1 });
promoClickSchema.index({ month: 1, promoter: 1 });
promoClickSchema.index({ at: 1 }, { expireAfterSeconds: 120 * 86400 });
export const PromoClick = model<IPromoClick>("PromoClick", promoClickSchema);

/** A member's month: counted clicks, the ones turned away (and why), and the payout. */
export const REJECT_REASONS = ["repeat", "own", "ip", "bot", "noid"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
export interface IPromoMonth extends Document {
  user: Types.ObjectId;
  month: string;
  clicks: number;
  rejected: Partial<Record<RejectReason, number>>;
  paidAt?: Date;
  paidGhs?: number;
  paidNote?: string;
}
const promoMonthSchema = new Schema<IPromoMonth>({
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  month: { type: String, required: true },
  clicks: { type: Number, default: 0 },
  rejected: Object.fromEntries(REJECT_REASONS.map((r) => [r, { type: Number }])),
  paidAt: { type: Date },
  paidGhs: { type: Number },
  paidNote: { type: String },
});
promoMonthSchema.index({ user: 1, month: 1 }, { unique: true });
promoMonthSchema.index({ month: 1, clicks: -1 });
export const PromoMonth = model<IPromoMonth>("PromoMonth", promoMonthSchema);

/** Where links go until DMY changes it: Lenko's latest official videos on DMY's channel. */
export const PROMO_DEFAULT_TARGETS = [
  "https://www.youtube.com/watch?v=IXeVtkRk2c0", // It's Working ft Lalid x Kofi Mole
  "https://www.youtube.com/watch?v=lx54UgazI-E", // Shiver ft Okese1
  "https://www.youtube.com/watch?v=jilOloNqdUE", // Dream Big ft Kojo Gidi x Levic Muzik
  "https://www.youtube.com/watch?v=psFEABrUbws", // Ready
];

/** Program settings DMY can change in admin (one document). */
export interface IPromoSettings extends Document<string> {
  open: boolean; // untick to stop counting clicks
  targets: string[]; // where links go: each visit goes to one of these YouTube links
  target?: string; // before 2026-10-30: one link for every visit (no longer used)
}
const promoSettingsSchema = new Schema<IPromoSettings>({
  _id: { type: String, default: "settings" },
  open: { type: Boolean, default: true },
  targets: { type: [String], default: () => [...PROMO_DEFAULT_TARGETS] },
  target: { type: String },
});
export const PromoSettings = model<IPromoSettings>("PromoSettings", promoSettingsSchema);
