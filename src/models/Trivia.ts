import { Schema, model, Document, Types } from "mongoose";

/**
 * Lenko Trivia — the LA End of Month Exam, for signed-in members: the last day of
 * every month, 12:00–12:10 GMT (DMY can move a month's). While it's open, each member taps once for ONE question (not
 * necessarily the same one as everyone else) and has a couple of minutes from that tap
 * to answer. Right / wrong only — no points. Players who get theirs right go on that
 * month's public board and share the month's prize (DMY decides the split and pays by hand).
 */

/**
 * A question in the bank. `answers` are the accepted answers — never sent to players.
 * A lyric question also asks for the song: `songAnswers` are the accepted titles, and
 * both parts must be right.
 */
export interface ITriviaQuestion extends Document {
  text: string;
  answers: string[];
  songAnswers: string[]; // empty: no song part
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
    songAnswers: { type: [String], default: [] },
    active: { type: Boolean, default: false, index: true },
    asked: { type: Number, default: 0 },
    correct: { type: Number, default: 0 },
  },
  { timestamps: true }
);
export const TriviaQuestion = model<ITriviaQuestion>("TriviaQuestion", triviaQuestionSchema);

/** One session (one round): everyone who played it, numbered in order. */
export interface ITriviaRound extends Document {
  number: number;
  session?: string; // the session's start (ISO) — one round per session
  startedAt: Date;
  endsAt: Date; // when every player's time is up
  players: number;
  createdAt: Date;
}
const triviaRoundSchema = new Schema<ITriviaRound>(
  {
    number: { type: Number, required: true, unique: true },
    session: { type: String, unique: true, sparse: true },
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
  songAnswer?: string; // the song they named (lyric questions)
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
    songAnswer: { type: String, trim: true, maxlength: 200 },
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
// One attempt per player per question, ever — and one question per player per session.
triviaAttemptSchema.index({ user: 1, question: 1 }, { unique: true });
triviaAttemptSchema.index({ round: 1, user: 1 }, { unique: true });
triviaAttemptSchema.index({ user: 1, result: 1 });
export const TriviaAttempt = model<ITriviaAttempt>("TriviaAttempt", triviaAttemptSchema);

/** Settings DMY can change in admin (one document). */
export interface ITriviaSettings extends Document<string> {
  open: boolean; // untick to pause the game
  sessionStartsAt: Date | null; // moves that month's exam (otherwise: the last day at 12:00 GMT)
  sessionMinutes: number; // how long members have to start their question
  seconds: number; // time to answer, from the tap
  prizeGhs: number;
  requireConfirmedEmail: boolean;
}
const triviaSettingsSchema = new Schema<ITriviaSettings>({
  _id: { type: String, default: "settings" },
  open: { type: Boolean, default: true },
  sessionStartsAt: { type: Date, default: null },
  sessionMinutes: { type: Number, default: 10, min: 1, max: 240 },
  seconds: { type: Number, default: 120, min: 20, max: 600 },
  prizeGhs: { type: Number, default: 1500, min: 0 },
  requireConfirmedEmail: { type: Boolean, default: true },
});
export const TriviaSettings = model<ITriviaSettings>("TriviaSettings", triviaSettingsSchema);
