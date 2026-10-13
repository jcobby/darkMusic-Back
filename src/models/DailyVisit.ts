import { Schema, model, Document } from "mongoose";

/** One document per calendar day (UTC), holding that day's visit count. */
export interface IDailyVisit extends Document {
  date: string; // YYYY-MM-DD (UTC)
  count: number;
  /** Visits per hour of the day, keyed "0"–"23" (UTC — the same as Ghana time).
   *  Days recorded before hourly tracking started have no entries. */
  hours?: Map<string, number>;
}

const dailyVisitSchema = new Schema<IDailyVisit>({
  date: { type: String, required: true, unique: true, index: true },
  count: { type: Number, default: 0 },
  hours: { type: Map, of: Number },
});

export const DailyVisit = model<IDailyVisit>("DailyVisit", dailyVisitSchema);
