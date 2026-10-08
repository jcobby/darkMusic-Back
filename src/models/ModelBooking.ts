import { Schema, model, Document, Types } from "mongoose";

/**
 * requested → (model) accepted | declined → (customer pays) paid → (after the
 * shoot) completed. Either side can cancel before payment; DMY can cancel any
 * time (refunds are handled by hand). "new" / "read" / "archived" belong to the
 * free-text enquiries sent before the marketplace existed.
 */
export type BookingStatus =
  | "requested"
  | "accepted"
  | "declined"
  | "paid"
  | "completed"
  | "cancelled"
  | "new"
  | "read"
  | "archived";

export interface IBookingReview {
  stars: number; // 1–5
  comment?: string;
  createdAt: Date;
}

/** A booking a customer makes for a specific model. */
export interface IModelBooking extends Document {
  modelId: Types.ObjectId;
  modelName: string; // snapshot of the model's name at time of booking
  customer?: Types.ObjectId; // the customer's account (absent on legacy enquiries)
  clientName: string;
  email: string;
  phone?: string;

  // What the customer asked for
  date?: string; // YYYY-MM-DD
  time?: string; // HH:mm
  location?: string;
  eventType?: string; // shoot type
  durationHours?: number;
  modelsCount?: number; // total models the customer needs for the job
  message?: string; // special requirements
  offerGhs?: number;
  budget?: string; // legacy free-text budget

  // Set when the model accepts (frozen so later rate changes don't touch it)
  priceGhs?: number;
  commissionGhs?: number;
  payoutGhs?: number;
  respondedAt?: Date;
  declineReason?: string;

  // Payment (every Paystack reference tried, so a late payment on an old tab still matches)
  paymentRefs: string[];
  paystackRef?: string;
  paidAt?: Date;

  completedAt?: Date;
  cancelledAt?: Date;
  cancelledBy?: "customer" | "model" | "admin";

  // DMY pays the model by hand after the shoot
  payoutStatus: "unpaid" | "paid";
  payoutAt?: Date;
  payoutNote?: string;

  review?: IBookingReview;

  status: BookingStatus;
  createdAt: Date;
  updatedAt: Date;
}

const reviewSchema = new Schema<IBookingReview>(
  {
    stars: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, trim: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const modelBookingSchema = new Schema<IModelBooking>(
  {
    modelId: { type: Schema.Types.ObjectId, ref: "ModelProfile", required: true, index: true },
    modelName: { type: String, required: true, trim: true },
    customer: { type: Schema.Types.ObjectId, ref: "User", index: true },
    clientName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, trim: true },

    date: { type: String, trim: true },
    time: { type: String, trim: true },
    location: { type: String, trim: true },
    eventType: { type: String, trim: true },
    durationHours: { type: Number, min: 0 },
    modelsCount: { type: Number, min: 1 },
    message: { type: String, trim: true },
    offerGhs: { type: Number, min: 0 },
    budget: { type: String, trim: true },

    priceGhs: { type: Number, min: 0 },
    commissionGhs: { type: Number, min: 0 },
    payoutGhs: { type: Number, min: 0 },
    respondedAt: { type: Date },
    declineReason: { type: String, trim: true },

    paymentRefs: { type: [String], default: [], index: true },
    paystackRef: { type: String },
    paidAt: { type: Date },

    completedAt: { type: Date },
    cancelledAt: { type: Date },
    cancelledBy: { type: String, enum: ["customer", "model", "admin"] },

    payoutStatus: { type: String, enum: ["unpaid", "paid"], default: "unpaid" },
    payoutAt: { type: Date },
    payoutNote: { type: String, trim: true },

    review: { type: reviewSchema },

    status: {
      type: String,
      enum: [
        "requested",
        "accepted",
        "declined",
        "paid",
        "completed",
        "cancelled",
        "new",
        "read",
        "archived",
      ],
      default: "requested",
      index: true,
    },
  },
  { timestamps: true }
);

export const ModelBooking = model<IModelBooking>("ModelBooking", modelBookingSchema);
