import { Schema, model, Document, Types } from "mongoose";

/** A fan's best score in a game for one calendar month (UTC) — the prize leaderboard. */
export interface IGameScore extends Document {
  user: Types.ObjectId;
  name: string; // shown publicly as first name + initial
  game: string; // "beat-breaker"
  month: string; // "2026-10"
  score: number;
  level: number;
  achievedAt: Date; // when this best was set (earlier wins a tie)
  runs: number; // verified runs submitted this month
  disqualified: boolean; // removed from the board by DMY after review
}

const gameScoreSchema = new Schema<IGameScore>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true },
    game: { type: String, required: true },
    month: { type: String, required: true },
    score: { type: Number, required: true, min: 0 },
    level: { type: Number, default: 1 },
    achievedAt: { type: Date, required: true },
    runs: { type: Number, default: 0 },
    disqualified: { type: Boolean, default: false },
  },
  { timestamps: true }
);
gameScoreSchema.index({ game: 1, month: 1, user: 1 }, { unique: true });
gameScoreSchema.index({ game: 1, month: 1, score: -1, achievedAt: 1 });

export const GameScore = model<IGameScore>("GameScore", gameScoreSchema);

// Prize money (the pool, wallets and withdrawals) lives in models/Wallet.ts.
