import { Schema, model, Document } from "mongoose";

export type OrderItemKind = "release_mp3" | "beat_wav" | "merch";

export interface IOrderItem {
  kind: OrderItemKind;
  refId: string; // Release / Beat / MerchProduct id
  name: string;
  amountGhs: number; // unit price at time of purchase
  qty: number;
  // merch options snapshot
  size?: string;
}

export interface IDownloadToken {
  token: string;
  kind: OrderItemKind; // release_mp3 | beat_wav (merch produces none)
  refId: string;
  fileKey: string; // resolved storage filename to stream
  name: string;
  expiresAt: Date;
  uses: number;
  maxUses: number;
}

export interface IOrder extends Document {
  reference: string; // our reference, also sent to Paystack
  customerEmail: string;
  customerName?: string;
  items: IOrderItem[];
  totalGhs: number;
  status: "pending" | "paid" | "failed";
  paystackRef?: string;
  downloadTokens: IDownloadToken[];
  createdAt: Date;
  updatedAt: Date;
}

const orderItemSchema = new Schema<IOrderItem>(
  {
    kind: {
      type: String,
      enum: ["release_mp3", "beat_wav", "merch"],
      required: true,
    },
    refId: { type: String, required: true },
    name: { type: String, required: true },
    amountGhs: { type: Number, required: true, min: 0 },
    qty: { type: Number, default: 1, min: 1 },
    size: { type: String },
  },
  { _id: false }
);

const downloadTokenSchema = new Schema<IDownloadToken>(
  {
    token: { type: String, required: true, index: true },
    kind: { type: String, enum: ["release_mp3", "beat_wav", "merch"], required: true },
    refId: { type: String, required: true },
    fileKey: { type: String, required: true },
    name: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    uses: { type: Number, default: 0 },
    maxUses: { type: Number, default: 5 },
  },
  { _id: false }
);

const orderSchema = new Schema<IOrder>(
  {
    reference: { type: String, required: true, unique: true, index: true },
    customerEmail: { type: String, required: true, trim: true, lowercase: true },
    customerName: { type: String, trim: true },
    items: { type: [orderItemSchema], default: [] },
    totalGhs: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ["pending", "paid", "failed"],
      default: "pending",
      index: true,
    },
    paystackRef: { type: String, trim: true },
    downloadTokens: { type: [downloadTokenSchema], default: [] },
  },
  { timestamps: true }
);

export const Order = model<IOrder>("Order", orderSchema);
