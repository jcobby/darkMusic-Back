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
  bestStreak?: number; // longest check-in streak ever — sets their Lenko Army rank (services/flair)
  lastCheckIn?: string; // YYYY-MM-DD (UTC) of the last check-in
  nameColor?: string; // the name colour they picked on the boards (one they've unlocked)
  squadFreeAt?: Date; // left a squad: can't join another until then (models/Squad)
  // DMY Pool ranked ladder (services/pool)
  poolRating?: number;
  poolWins?: number;
  poolLosses?: number;
  referralCode: string; // this fan's own code to share
  referredBy?: string; // referralCode that invited this fan
  resetTokenHash?: string; // sha256 of the password-reset token
  resetTokenExpires?: Date;
  streamUntil?: Date; // active streaming-pass expiry
  lastSeenAt?: Date; // last time they opened the site signed in (updated at most hourly)
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
    bestStreak: { type: Number, default: 0, min: 0 },
    lastCheckIn: { type: String },
    nameColor: { type: String },
    squadFreeAt: { type: Date },
    poolRating: { type: Number },
    poolWins: { type: Number },
    poolLosses: { type: Number },
    referralCode: { type: String, required: true, unique: true, index: true },
    referredBy: { type: String },
    resetTokenHash: { type: String, index: true },
    resetTokenExpires: { type: Date },
    streamUntil: { type: Date },
    lastSeenAt: { type: Date },
  },
  { timestamps: true }
);
// The DMY Pool ladder (only players who've played a ranked match have a rating)
userSchema.index({ poolRating: -1 }, { partialFilterExpression: { poolRating: { $exists: true } } });

export const User = model<IUser>("User", userSchema);
