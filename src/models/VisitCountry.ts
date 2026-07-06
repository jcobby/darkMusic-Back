import { Schema, model, Document } from "mongoose";

/** One document per country (ISO code) that has visited, with a hit count.
 *  The number of documents = distinct countries shown in the live stats. */
export interface IVisitCountry extends Document {
  code: string; // ISO 3166-1 alpha-2, e.g. "GH"
  count: number;
}

const visitCountrySchema = new Schema<IVisitCountry>({
  code: { type: String, required: true, unique: true, index: true, uppercase: true },
  count: { type: Number, default: 0 },
});

export const VisitCountry = model<IVisitCountry>("VisitCountry", visitCountrySchema);
