import { Schema, model, Document, Types } from "mongoose";

/** A booking request a client submits for a specific model. */
export interface IModelBooking extends Document {
  modelId: Types.ObjectId;
  modelName: string; // snapshot of the model's name at time of booking
  clientName: string;
  email: string;
  phone?: string;
  date?: string; // date needed
  eventType?: string; // what it's for (music video, event, shoot, promo…)
  budget?: string;
  message?: string;
  status: "new" | "read" | "archived";
  createdAt: Date;
  updatedAt: Date;
}

const modelBookingSchema = new Schema<IModelBooking>(
  {
    modelId: { type: Schema.Types.ObjectId, ref: "ModelProfile", required: true, index: true },
    modelName: { type: String, required: true, trim: true },
    clientName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    date: { type: String, trim: true },
    eventType: { type: String, trim: true },
    budget: { type: String, trim: true },
    message: { type: String, trim: true },
    status: { type: String, enum: ["new", "read", "archived"], default: "new" },
  },
  { timestamps: true }
);

export const ModelBooking = model<IModelBooking>("ModelBooking", modelBookingSchema);
