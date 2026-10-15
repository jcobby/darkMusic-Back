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

export const MOMO_NETWORKS = ["MTN", "Telecel", "AirtelTigo"] as const;
export type MomoNetwork = (typeof MOMO_NETWORKS)[number];

/**
 * A month's prize. Once the month ends it goes to the top score ("won") and the
 * winner is emailed. They withdraw it from their account by giving a Mobile Money
 * number ("requested"); DMY checks the scores, sends the money and marks it "paid".
 */
export type PrizeStatus = "won" | "requested" | "paid";
export interface IGamePrize extends Document {
  game: string;
  month: string;
  user: Types.ObjectId;
  amountGhs: number;
  status?: PrizeStatus; // older records only had paidAt — see prizeStatus()
  notifiedAt?: Date;
  momoNetwork?: MomoNetwork;
  momoNumber?: string; // 10 digits, e.g. 0241234567
  accountName?: string;
  requestedAt?: Date;
  paidAt?: Date;
  note?: string;
}

const gamePrizeSchema = new Schema<IGamePrize>(
  {
    game: { type: String, required: true },
    month: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    amountGhs: { type: Number, required: true },
    status: { type: String, enum: ["won", "requested", "paid"] },
    notifiedAt: { type: Date },
    momoNetwork: { type: String, enum: MOMO_NETWORKS },
    momoNumber: { type: String, trim: true },
    accountName: { type: String, trim: true },
    requestedAt: { type: Date },
    paidAt: { type: Date },
    note: { type: String, trim: true },
  },
  { timestamps: true }
);

export const prizeStatus = (p: IGamePrize): PrizeStatus => p.status ?? (p.paidAt ? "paid" : "won");
gamePrizeSchema.index({ game: 1, month: 1 }, { unique: true });

export const GamePrize = model<IGamePrize>("GamePrize", gamePrizeSchema);
