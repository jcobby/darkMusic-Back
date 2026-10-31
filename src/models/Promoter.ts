import { Schema, model, Document, Types } from "mongoose";
import { MOMO_NETWORKS, type MomoNetwork } from "./Wallet";

/**
 * The Lenko Army promoter program (services/promoter): a member verifies their phone,
 * then clicks on their link (darkmusicyard.com/r/<referral code>) count each month
 * towards a cash reward.
 */
export type LinkKind = "device" | "phone" | "momo";
export interface IPromoter extends Document {
  user: Types.ObjectId;
  phone: string; // the number they verified by SMS ("0241234567") — one account per number
  verifiedAt: Date;
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
    phone: { type: String, required: true, unique: true },
    verifiedAt: { type: Date, required: true },
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

/** The code texted to a member's phone (one at a time per member). */
export interface IPhoneCode extends Document {
  user: Types.ObjectId;
  phone: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
}
const phoneCodeSchema = new Schema<IPhoneCode>({
  user: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  phone: { type: String, required: true },
  codeHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
});
phoneCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });
export const PhoneCode = model<IPhoneCode>("PhoneCode", phoneCodeSchema);

/** Every code text sent, for the limits per member and per number (kept a day). */
export interface ISmsSend extends Document {
  user: Types.ObjectId;
  phone: string;
  at: Date;
}
const smsSendSchema = new Schema<ISmsSend>({
  user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  phone: { type: String, required: true, index: true },
  at: { type: Date, required: true },
});
smsSendSchema.index({ at: 1 }, { expireAfterSeconds: 86400 });
export const SmsSend = model<ISmsSend>("SmsSend", smsSendSchema);
