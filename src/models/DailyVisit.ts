import { Schema, model, Document } from "mongoose";

/** One document per calendar day (UTC), holding that day's visit count. */
export interface IDailyVisit extends Document {
  date: string; // YYYY-MM-DD (UTC)
  count: number;
}

const dailyVisitSchema = new Schema<IDailyVisit>({
  date: { type: String, required: true, unique: true, index: true },
  count: { type: Number, default: 0 },
});

export const DailyVisit = model<IDailyVisit>("DailyVisit", dailyVisitSchema);
