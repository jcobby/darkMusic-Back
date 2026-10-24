import { Schema, model, Document, Types } from "mongoose";
import type { Frame, Outcome, BallState, Shot } from "../pool/engine";

/**
 * A DMY Pool match between two fans: best of 1, 3 or 5 frames of 8-ball. Ranked
 * matches come from the matchmaking queue and move ratings; friend challenges (by
 * invite link) don't. The server plays every shot out itself (services/pool).
 */
export type PoolStatus = "waiting" | "playing" | "finished" | "cancelled";

/** The last thing that happened on the table — what the other player's page animates. */
export interface PoolShotRecord {
  no: number; // the match's shot number after it
  by: 0 | 1;
  frameNo: number;
  timeout?: boolean; // ran out of time (no shot)
  shot?: Shot;
  cue?: { x: number; y: number }; // where they placed the cue ball (ball in hand)
  start?: BallState[]; // the table as the shot was taken
  outcome?: Outcome;
}

export interface IPoolMatch extends Document {
  code: string; // in links: /games/pool?m=CODE
  ranked: boolean;
  bestOf: 1 | 3 | 5;
  players: { user: Types.ObjectId; name: string; rating: number; timeouts: number; ip?: string }[];
  status: PoolStatus;
  frames: [number, number]; // frames won
  frameNo: number;
  breaker: 0 | 1; // who broke this frame (it alternates)
  frame: Frame | null;
  shotNo: number; // goes up with every change on the table (saves race on it)
  lastShot: PoolShotRecord | null;
  turnEndsAt: Date | null;
  winner: 0 | 1 | null;
  reason?: string; // how it ended
  ratingChange?: [number, number];
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const poolMatchSchema = new Schema<IPoolMatch>(
  {
    code: { type: String, required: true, unique: true },
    ranked: { type: Boolean, default: false },
    bestOf: { type: Number, enum: [1, 3, 5], default: 3 },
    players: [
      {
        _id: false,
        user: { type: Schema.Types.ObjectId, ref: "User", required: true },
        name: { type: String, required: true },
        rating: { type: Number, default: 1000 },
        timeouts: { type: Number, default: 0 },
        ip: { type: String },
      },
    ],
    status: { type: String, enum: ["waiting", "playing", "finished", "cancelled"], default: "waiting" },
    frames: { type: [Number], default: [0, 0] },
    frameNo: { type: Number, default: 1 },
    breaker: { type: Number, default: 0 },
    frame: { type: Schema.Types.Mixed, default: null },
    shotNo: { type: Number, default: 0 },
    lastShot: { type: Schema.Types.Mixed, default: null },
    turnEndsAt: { type: Date, default: null },
    winner: { type: Number, default: null },
    reason: { type: String },
    ratingChange: { type: [Number], default: undefined },
    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  { timestamps: true }
);
poolMatchSchema.index({ "players.user": 1, status: 1 });
poolMatchSchema.index({ ranked: 1, finishedAt: -1 });

export const PoolMatch = model<IPoolMatch>("PoolMatch", poolMatchSchema);
