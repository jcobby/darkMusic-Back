import { Schema, model, Document } from "mongoose";

/** A month of DMY membership (Supporter, VIP or Legend) — a one-time Paystack payment, like the streaming pass. */
export interface IMembership extends Document {
  reference: string;
  user: string; // User _id
  email: string;
  tier: "supporter" | "vip" | "legend";
  amountGhs: number;
  status: "pending" | "paid" | "failed";
  paystackRef?: string;
  until?: Date; // the membership's end once this payment was applied
  createdAt: Date;
  updatedAt: Date;
}

const membershipSchema = new Schema<IMembership>(
  {
    reference: { type: String, required: true, unique: true, index: true },
    user: { type: String, required: true, index: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    tier: { type: String, enum: ["supporter", "vip", "legend"], required: true },
    amountGhs: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ["pending", "paid", "failed"], default: "pending", index: true },
    paystackRef: { type: String, trim: true },
    until: { type: Date },
  },
  { timestamps: true }
);

export const Membership = model<IMembership>("Membership", membershipSchema);
