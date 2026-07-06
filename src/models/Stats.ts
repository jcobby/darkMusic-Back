import { Schema, model, Document } from "mongoose";

/** Singleton document holding site-wide counters powering the live stats. */
export interface IStats extends Document {
  visits: number;
  plays: number; // on-site audio plays (previews / player)
  downloads: number; // paid release MP3 units sold
  beatSales: number; // paid beat WAV units sold
  merchSales: number; // merch units sold
}

const statsSchema = new Schema<IStats>({
  visits: { type: Number, default: 0 },
  plays: { type: Number, default: 0 },
  downloads: { type: Number, default: 0 },
  beatSales: { type: Number, default: 0 },
  merchSales: { type: Number, default: 0 },
});

export const Stats = model<IStats>("Stats", statsSchema);
