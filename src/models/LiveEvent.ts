import { Schema, model, Document, Types } from "mongoose";

/**
 * A pay-per-view live performance. The stream itself is an unlisted YouTube
 * Live (and its replay) — the link is only ever sent to ticket holders.
 */
export interface ILiveEvent extends Document {
  title: string;
  slug: string;
  description?: string;
  poster?: string; // Cloudinary URL
  startsAt: Date;
  durationMins: number; // how long it counts as "live" after it starts
  priceGhs: number;
  streamUrl?: string; // unlisted YouTube Live / replay URL — never public
  replay: boolean; // ticket holders can watch the replay after the show
  hidden: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const liveEventSchema = new Schema<ILiveEvent>(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    description: { type: String, trim: true },
    poster: { type: String },
    startsAt: { type: Date, required: true },
    durationMins: { type: Number, default: 120, min: 15 },
    priceGhs: { type: Number, required: true, min: 1 },
    streamUrl: { type: String, trim: true },
    replay: { type: Boolean, default: true },
    hidden: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const LiveEvent = model<ILiveEvent>("LiveEvent", liveEventSchema);

/** One fan's ticket to one live event. */
export interface ILiveTicket extends Document {
  event: Types.ObjectId;
  user: Types.ObjectId;
  email: string;
  amountGhs: number;
  status: "pending" | "paid";
  paymentRefs: string[];
  paystackRef?: string;
  paidAt?: Date;
  createdAt: Date;
}

const liveTicketSchema = new Schema<ILiveTicket>(
  {
    event: { type: Schema.Types.ObjectId, ref: "LiveEvent", required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    amountGhs: { type: Number, required: true },
    status: { type: String, enum: ["pending", "paid"], default: "pending" },
    paymentRefs: { type: [String], default: [], index: true },
    paystackRef: { type: String },
    paidAt: { type: Date },
  },
  { timestamps: true }
);
liveTicketSchema.index({ event: 1, user: 1 }, { unique: true });

export const LiveTicket = model<ILiveTicket>("LiveTicket", liveTicketSchema);
