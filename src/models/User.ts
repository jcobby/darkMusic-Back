import { Schema, model, Document } from "mongoose";

/** A fan account. Foundation for rewards, favourites, the Fan Wall, etc. */
export interface IUser extends Document {
  email: string;
  passwordHash: string;
  name?: string;
  phone?: string;
  emailVerified: boolean; // true once the email address is confirmed
  verifyTokenHash?: string; // sha256 of the email-verification token
  verifyTokenExpires?: Date;
  points: number; // loyalty points balance
  streak: number; // consecutive daily check-ins
  lastCheckIn?: string; // YYYY-MM-DD (UTC) of the last check-in
  referralCode: string; // this fan's own code to share
  referredBy?: string; // referralCode that invited this fan
  resetTokenHash?: string; // sha256 of the password-reset token
  resetTokenExpires?: Date;
  streamUntil?: Date; // active streaming-pass expiry
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    emailVerified: { type: Boolean, default: false },
    verifyTokenHash: { type: String, index: true },
    verifyTokenExpires: { type: Date },
    points: { type: Number, default: 0, min: 0 },
    streak: { type: Number, default: 0, min: 0 },
    lastCheckIn: { type: String },
    referralCode: { type: String, required: true, unique: true, index: true },
    referredBy: { type: String },
    resetTokenHash: { type: String, index: true },
    resetTokenExpires: { type: Date },
    streamUntil: { type: Date },
  },
  { timestamps: true }
);

export const User = model<IUser>("User", userSchema);
