import { Schema, model, Document, Types } from "mongoose";
import type { IBoardEntry } from "./GameScore";

/**
 * A game event DMY schedules — a weekly challenge or a live mini-tournament
 * ("Tonight 8–9pm"): its own board for a time window, and prize money for the top
 * places. A game counts if it STARTED in the window, and what it scores before the
 * end counts. See services/events.
 */
export type EventKind = "weekly" | "live";
/** best: the highest single game · days: the best game each day added up · wins: ranked wins (Pool) */
export type EventMetric = "best" | "days" | "wins";

export interface IGameEvent extends Document {
  slug: string;
  title: string;
  description?: string;
  game: string; // "beat-breaker" or "pool"
  kind: EventKind;
  metric: EventMetric;
  startsAt: Date;
  endsAt: Date;
  prizeGhs: number; // 0: bragging rights only
  split: number[]; // % of the prize for 1st, 2nd, 3rd… (adds up to 100)
  cancelled: boolean;
  settledAt?: Date | null; // prizes paid into the winners' wallets
  winners: { place: number; user: Types.ObjectId; name: string; score: number; amountGhs: number }[];
  createdBy?: string; // admin email
  createdAt: Date;
  updatedAt: Date;
}

const gameEventSchema = new Schema<IGameEvent>(
  {
    slug: { type: String, required: true, unique: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    game: { type: String, required: true },
    kind: { type: String, enum: ["weekly", "live"], required: true },
    metric: { type: String, enum: ["best", "days", "wins"], default: "best" },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    prizeGhs: { type: Number, default: 0, min: 0 },
    split: { type: [Number], default: [100] },
    cancelled: { type: Boolean, default: false },
    settledAt: { type: Date, default: null },
    winners: [
      {
        _id: false,
        place: Number,
        user: { type: Schema.Types.ObjectId, ref: "User" },
        name: String,
        score: Number,
        amountGhs: Number,
      },
    ],
    createdBy: { type: String },
  },
  { timestamps: true }
);
gameEventSchema.index({ game: 1, endsAt: 1 });

export const GameEvent = model<IGameEvent>("GameEvent", gameEventSchema);

/** A fan's place on an event's board. */
export interface IGameEventEntry extends IBoardEntry {
  event: Types.ObjectId;
  byDay?: Record<string, number>; // metric "days": the best game each day ("2026-11-03" → score)
}

const gameEventEntrySchema = new Schema<IGameEventEntry>(
  {
    event: { type: Schema.Types.ObjectId, ref: "GameEvent", required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    game: { type: String, required: true },
    score: { type: Number, required: true, min: 0 },
    level: { type: Number, default: 1 },
    bestRun: { type: Number },
    days: { type: Number },
    byDay: { type: Schema.Types.Mixed },
    achievedAt: { type: Date, required: true },
    runs: { type: Number, default: 0 },
    disqualified: { type: Boolean, default: false },
  },
  { timestamps: true }
);
gameEventEntrySchema.index({ event: 1, user: 1 }, { unique: true });
gameEventEntrySchema.index({ event: 1, score: -1, achievedAt: 1 });

export const GameEventEntry = model<IGameEventEntry>("GameEventEntry", gameEventEntrySchema);
