import { Schema, model, Document } from "mongoose";

/** Singleton document holding site-wide counters. */
export interface IStats extends Document {
  visits: number;
}

const statsSchema = new Schema<IStats>({
  visits: { type: Number, default: 0 },
});

export const Stats = model<IStats>("Stats", statsSchema);
