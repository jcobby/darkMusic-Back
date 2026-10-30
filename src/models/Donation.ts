import { Schema, model, Document } from "mongoose";

/** A fan donation / tip paid via Paystack. */
export interface IDonation extends Document {
  reference: string;
  name?: string;
  email: string;
  amountGhs: number;
  message?: string;
  showOnWall: boolean; // they agreed to their name on that month's Supporter Wall
  status: "pending" | "paid" | "failed";
  paystackRef?: string;
  createdAt: Date;
  updatedAt: Date;
}

const donationSchema = new Schema<IDonation>(
  {
    reference: { type: String, required: true, unique: true, index: true },
    name: { type: String, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    amountGhs: { type: Number, required: true, min: 1 },
    message: { type: String, trim: true },
    showOnWall: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["pending", "paid", "failed"],
      default: "pending",
      index: true,
    },
    paystackRef: { type: String, trim: true },
  },
  { timestamps: true }
);

export const Donation = model<IDonation>("Donation", donationSchema);
