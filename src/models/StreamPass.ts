import { Schema, model, Document } from "mongoose";

/** A 30-day streaming-pass purchase (one-time Paystack payment). */
export interface IStreamPass extends Document {
  reference: string;
  user: string; // User _id
  email: string;
  amountGhs: number;
  status: "pending" | "paid" | "failed";
  paystackRef?: string;
  createdAt: Date;
  updatedAt: Date;
}

const streamPassSchema = new Schema<IStreamPass>(
  {
    reference: { type: String, required: true, unique: true, index: true },
    user: { type: String, required: true, index: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    amountGhs: { type: Number, required: true, min: 1 },
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

export const StreamPass = model<IStreamPass>("StreamPass", streamPassSchema);
