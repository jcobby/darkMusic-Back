import { Schema, model, Document, Types } from "mongoose";

/**
 * A squad: 3–5 fans whose Beat Breaker month totals add up on the squad board.
 * Its tag shows next to members' names on every board. One squad per fan.
 */
export interface ISquad extends Document {
  name: string;
  nameKey: string; // lowercased, for uniqueness
  tag: string; // 2–5 capitals/digits, e.g. "LAW"
  code: string; // invite code
  captain: Types.ObjectId;
  members: { user: Types.ObjectId; joinedAt: Date }[];
  createdAt: Date;
  updatedAt: Date;
}

const squadSchema = new Schema<ISquad>(
  {
    name: { type: String, required: true, trim: true },
    nameKey: { type: String, required: true, unique: true },
    tag: { type: String, required: true, unique: true },
    code: { type: String, required: true, unique: true },
    captain: { type: Schema.Types.ObjectId, ref: "User", required: true },
    members: [{ _id: false, user: { type: Schema.Types.ObjectId, ref: "User", required: true }, joinedAt: { type: Date, default: Date.now } }],
  },
  { timestamps: true }
);
// A fan can only be in one squad.
squadSchema.index({ "members.user": 1 }, { unique: true, partialFilterExpression: { "members.user": { $exists: true } } });

export const Squad = model<ISquad>("Squad", squadSchema);

export const SQUAD_MIN = 3; // members before a squad goes on the board
export const SQUAD_MAX = 5;
export const SQUAD_COOLDOWN_DAYS = 3; // after leaving, before joining another
