import { Schema, model, Document, Types } from "mongoose";

/**
 * A beat DMY pinned as the Beat of the Day for a date. Days without one take the
 * next free beat in rotation (controllers/beatOfDay).
 */
export interface IBeatOfDay extends Document {
  day: string; // "2026-11-03" (Ghana time = UTC)
  beat: Types.ObjectId;
}

const beatOfDaySchema = new Schema<IBeatOfDay>(
  {
    day: { type: String, required: true, unique: true },
    beat: { type: Schema.Types.ObjectId, ref: "Beat", required: true },
  },
  { timestamps: true }
);

export const BeatOfDay = model<IBeatOfDay>("BeatOfDay", beatOfDaySchema);
