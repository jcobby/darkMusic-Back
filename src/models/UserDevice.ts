import { Schema, model, Document, Types } from "mongoose";

/**
 * A browser a fan has used their account on. The site gives every browser a random id
 * (X-DMY-Device), stored here hashed — two accounts on one device look like one person
 * to the Lenko Army promoter program (services/promoter).
 */
export interface IUserDevice extends Document {
  user: Types.ObjectId;
  device: string; // sha256 of the browser's id
  firstSeenAt: Date;
  lastSeenAt: Date;
}

const userDeviceSchema = new Schema<IUserDevice>({
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  device: { type: String, required: true, index: true },
  firstSeenAt: { type: Date, required: true },
  lastSeenAt: { type: Date, required: true },
});
userDeviceSchema.index({ user: 1, device: 1 }, { unique: true });

export const UserDevice = model<IUserDevice>("UserDevice", userDeviceSchema);
