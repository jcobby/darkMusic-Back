import { Schema, model, Document } from "mongoose";

export const INQUIRY_TYPES = ["feature", "brand", "contact"] as const;
export type InquiryType = (typeof INQUIRY_TYPES)[number];

/**
 * One submission from the Features, Brand Promotion, or Contact forms.
 * Fields are shared across types; only the relevant ones are populated.
 */
export interface IInquiry extends Document {
  type: InquiryType;
  name: string; // person / artist / business contact name
  email: string;
  phone?: string;
  // feature-specific
  artistName?: string;
  songLink?: string;
  budget?: string;
  deadline?: string;
  // brand-specific
  businessName?: string;
  service?: string;
  message?: string;
  status: "new" | "read" | "archived";
  createdAt: Date;
  updatedAt: Date;
}

const inquirySchema = new Schema<IInquiry>(
  {
    type: { type: String, enum: INQUIRY_TYPES, required: true, index: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    artistName: { type: String, trim: true },
    songLink: { type: String, trim: true },
    budget: { type: String, trim: true },
    deadline: { type: String, trim: true },
    businessName: { type: String, trim: true },
    service: { type: String, trim: true },
    message: { type: String, trim: true },
    status: { type: String, enum: ["new", "read", "archived"], default: "new" },
  },
  { timestamps: true }
);

export const Inquiry = model<IInquiry>("Inquiry", inquirySchema);
