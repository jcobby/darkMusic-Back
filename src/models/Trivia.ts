import { Schema, model, Document, Types } from "mongoose";

/**
 * Lenko Trivia — live rounds for signed-in members. A round starts when enough
 * players are ready at the same time; each gets one question (not necessarily the
 * same one) and a few minutes to answer. Right / wrong only — no points. Players
 * who get theirs right go on the public board and share the prize (DMY decides).
 */

/** A question in the bank. `answers` are the accepted answers — never sent to players. */
export interface ITriviaQuestion extends Document {
  text: string;
  answers: string[];
  active: boolean;
  asked: number; // times given to a player
  correct: number; // times answered correctly
  createdAt: Date;
  updatedAt: Date;
}
const triviaQuestionSchema = new Schema<ITriviaQuestion>(
  {
    text: { type: String, required: true, trim: true, maxlength: 500 },
    answers: { type: [String], default: [] },
    active: { type: Boolean, default: false, index: true },
    asked: { type: Number, default: 0 },
    correct: { type: Number, default: 0 },
  },
  { timestamps: true }
);
export const TriviaQuestion = model<ITriviaQuestion>("TriviaQuestion", triviaQuestionSchema);

export interface ITriviaRound extends Document {
  number: number;
  startedAt: Date;
  endsAt: Date; // when every player's time is up
  players: number;
  createdAt: Date;
}
const triviaRoundSchema = new Schema<ITriviaRound>(
  {
    number: { type: Number, required: true, unique: true },
    startedAt: { type: Date, required: true },
    endsAt: { type: Date, required: true, index: true },
    players: { type: Number, default: 0 },
  },
  { timestamps: true }
);
export const TriviaRound = model<ITriviaRound>("TriviaRound", triviaRoundSchema);

export type TriviaResult = "pending" | "correct" | "wrong" | "unanswered";

/** One player's question in one round — their only attempt at that question. */
export interface ITriviaAttempt extends Document {
  round: Types.ObjectId;
  roundNumber: number;
  user: Types.ObjectId;
  name: string; // shown on the board as first name + initial
  question: Types.ObjectId;
  assignedAt: Date;
  deadline: Date;
  answer?: string;
  submittedAt?: Date | null;
  result: TriviaResult;
  overridden: boolean; // DMY changed the result by hand
  ip?: string;
  paidGhs?: number | null;
  paidNote?: string;
  paidAt?: Date | null;
  createdAt: Date;
}
const triviaAttemptSchema = new Schema<ITriviaAttempt>(
  {
    round: { type: Schema.Types.ObjectId, ref: "TriviaRound", required: true, index: true },
    roundNumber: { type: Number, required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true },
    question: { type: Schema.Types.ObjectId, ref: "TriviaQuestion", required: true },
    assignedAt: { type: Date, required: true },
    deadline: { type: Date, required: true },
    answer: { type: String, trim: true, maxlength: 200 },
    submittedAt: { type: Date, default: null },
    result: { type: String, enum: ["pending", "correct", "wrong", "unanswered"], default: "pending", index: true },
    overridden: { type: Boolean, default: false },
    ip: { type: String },
    paidGhs: { type: Number, default: null },
    paidNote: { type: String, trim: true },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true }
);
// One attempt per player per question, ever.
triviaAttemptSchema.index({ user: 1, question: 1 }, { unique: true });
triviaAttemptSchema.index({ user: 1, result: 1 });
export const TriviaAttempt = model<ITriviaAttempt>("TriviaAttempt", triviaAttemptSchema);

/** Settings DMY can change in admin (one document). */
export interface ITriviaSettings extends Document<string> {
  open: boolean; // players can join the lobby
  minPlayers: number; // ready at the same time before a round starts
  seconds: number; // time to answer
  prizeGhs: number;
  requireConfirmedEmail: boolean;
}
const triviaSettingsSchema = new Schema<ITriviaSettings>({
  _id: { type: String, default: "settings" },
  open: { type: Boolean, default: true },
  minPlayers: { type: Number, default: 10, min: 2, max: 500 },
  seconds: { type: Number, default: 120, min: 20, max: 600 },
  prizeGhs: { type: Number, default: 1000, min: 0 },
  requireConfirmedEmail: { type: Boolean, default: true },
});
export const TriviaSettings = model<ITriviaSettings>("TriviaSettings", triviaSettingsSchema);
