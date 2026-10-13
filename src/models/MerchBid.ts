import { Schema, model, Document, Types } from "mongoose";

/** One bid on a merch auction. The product keeps the current leader; this is the history. */
export interface IMerchBid extends Document {
  product: Types.ObjectId;
  user: Types.ObjectId;
  name: string; // shown publicly as first name + initial
  amountGhs: number;
  size?: string;
  createdAt: Date;
}

const merchBidSchema = new Schema<IMerchBid>(
  {
    product: { type: Schema.Types.ObjectId, ref: "MerchProduct", required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true },
    amountGhs: { type: Number, required: true, min: 1 },
    size: { type: String, trim: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
merchBidSchema.index({ product: 1, createdAt: -1 });
merchBidSchema.index({ user: 1, createdAt: -1 });

export const MerchBid = model<IMerchBid>("MerchBid", merchBidSchema);
