import { Schema, model, Document, Types } from "mongoose";

/** A fan's place on a Beat Breaker board — the same on the month's board and the week's. */
export interface IBoardEntry extends Document {
  user: Types.ObjectId;
  name: string; // shown publicly as first name + initial
  game: string; // "beat-breaker"
  score: number;
  level: number; // highest level reached (months before the daily rules: the best game's level)
  bestRun?: number; // best single game (daily rules)
  days?: number; // days played (daily rules)
  achievedAt: Date; // when the score last went up (earlier wins a tie)
  runs: number; // verified runs submitted
  disqualified: boolean; // removed from the board by DMY after review
}

const boardFields = {
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  name: { type: String, required: true },
  game: { type: String, required: true },
  score: { type: Number, required: true, min: 0 },
  level: { type: Number, default: 1 },
  bestRun: { type: Number },
  days: { type: Number },
  achievedAt: { type: Date, required: true },
  runs: { type: Number, default: 0 },
  disqualified: { type: Boolean, default: false },
};

/**
 * A fan's calendar month (UTC) — the prize leaderboard. From November 2026 `score`
 * is the month's total (their best days added up — see services/gameScoring);
 * before that it was their single best game.
 */
export interface IGameScore extends IBoardEntry {
  month: string; // "2026-10"
}

const gameScoreSchema = new Schema<IGameScore>({ ...boardFields, month: { type: String, required: true } }, { timestamps: true });
gameScoreSchema.index({ game: 1, month: 1, user: 1 }, { unique: true });
gameScoreSchema.index({ game: 1, month: 1, score: -1, achievedAt: 1 });

export const GameScore = model<IGameScore>("GameScore", gameScoreSchema);

/** A fan's week (Monday–Sunday, UTC) on the weekly board: every day that week added up. No prize. */
export interface IGameWeek extends IBoardEntry {
  week: string; // its Monday, "2026-11-02"
}

const gameWeekSchema = new Schema<IGameWeek>({ ...boardFields, week: { type: String, required: true } }, { timestamps: true });
gameWeekSchema.index({ game: 1, week: 1, user: 1 }, { unique: true });
gameWeekSchema.index({ game: 1, week: 1, score: -1, achievedAt: 1 });

export const GameWeek = model<IGameWeek>("GameWeek", gameWeekSchema);

/** A fan's day (UTC) on the daily sprint board: their best 15-minute sprint game that day. No prize. */
export interface IGameSprint extends IBoardEntry {
  day: string; // "2026-11-03"
}

const gameSprintSchema = new Schema<IGameSprint>({ ...boardFields, day: { type: String, required: true } }, { timestamps: true });
gameSprintSchema.index({ game: 1, day: 1, user: 1 }, { unique: true });
gameSprintSchema.index({ game: 1, day: 1, score: -1, achievedAt: 1 });

export const GameSprint = model<IGameSprint>("GameSprint", gameSprintSchema);

/** A fan's day (UTC): their best game that day and what it adds to the month's and the week's boards. */
export interface IGameDay extends Document {
  user: Types.ObjectId;
  name: string;
  game: string;
  day: string; // "2026-11-03"
  month: string; // "2026-11"
  week: string; // its Monday
  best: number; // best game that day
  level: number; // highest level reached that day
  streak: number; // days in a row, counting this one (fixed when the day's first game is saved)
  points: number; // the best game plus the streak bonus
  runs: number;
}

const gameDaySchema = new Schema<IGameDay>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    game: { type: String, required: true },
    day: { type: String, required: true },
    month: { type: String, required: true },
    week: { type: String, required: true },
    best: { type: Number, default: 0 },
    level: { type: Number, default: 1 },
    streak: { type: Number, default: 1 },
    points: { type: Number, default: 0 },
    runs: { type: Number, default: 0 },
  },
  { timestamps: true }
);
gameDaySchema.index({ game: 1, user: 1, day: 1 }, { unique: true });

export const GameDay = model<IGameDay>("GameDay", gameDaySchema);

// Prize money (the pool, wallets and withdrawals) lives in models/Wallet.ts.
