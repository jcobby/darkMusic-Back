import { Schema, model, Document, Types } from "mongoose";

/*
 * Game prize money, kept fully on the record:
 *  - PrizeDeposit: money DMY pays INTO a month's prize pool through Paystack.
 *    Players see every paid deposit (amount, date, Paystack reference).
 *  - WalletTxn: each player's prize wallet — a prize credited at the end of the
 *    month or of a game event, and the withdrawals they make to Mobile Money (sent by Paystack).
 */

export const MOMO_NETWORKS = ["MTN", "Telecel", "AirtelTigo"] as const;
export type MomoNetwork = (typeof MOMO_NETWORKS)[number];
/** Paystack's Ghana mobile-money bank codes (GET /bank?currency=GHS&type=mobile_money). */
export const PAYSTACK_MOMO_CODE: Record<MomoNetwork, string> = { MTN: "MTN", Telecel: "VOD", AirtelTigo: "ATL" };

// ---------- Deposits into the prize pool ----------

export interface IPrizeDeposit extends Document {
  game: string;
  month: string; // "2026-10"
  amountGhs: number;
  reference: string; // Paystack reference
  status: "pending" | "paid" | "failed";
  paidAt?: Date;
  by?: string; // admin email
  createdAt: Date;
}

const prizeDepositSchema = new Schema<IPrizeDeposit>(
  {
    game: { type: String, required: true },
    month: { type: String, required: true },
    amountGhs: { type: Number, required: true, min: 1 },
    reference: { type: String, required: true, unique: true },
    status: { type: String, enum: ["pending", "paid", "failed"], default: "pending" },
    paidAt: { type: Date },
    by: { type: String },
  },
  { timestamps: true }
);
prizeDepositSchema.index({ game: 1, month: 1, status: 1 });

export const PrizeDeposit = model<IPrizeDeposit>("PrizeDeposit", prizeDepositSchema);

// ---------- Player wallets ----------

/** review: won, DMY checking the scores · available: can be withdrawn · void: taken back (disqualified). */
export type PrizeState = "review" | "available" | "void";
/** requested → (sending | otp) → paid; or failed / rejected / cancelled (the money stays in the wallet). */
export type WithdrawalState = "requested" | "sending" | "otp" | "paid" | "failed" | "rejected" | "cancelled";
export const OPEN_WITHDRAWAL: WithdrawalState[] = ["requested", "sending", "otp"];
/** Withdrawals that use up wallet money (anything not failed, rejected or cancelled). */
export const SPENDING_WITHDRAWAL: WithdrawalState[] = ["requested", "sending", "otp", "paid"];

export interface IWalletTxn extends Document {
  user: Types.ObjectId;
  kind: "prize" | "withdrawal";
  amountGhs: number;
  status: PrizeState | WithdrawalState;
  // Prize
  game?: string;
  month?: string;
  score?: number;
  availableAt?: Date; // end of the score check
  active?: boolean; // set on the month's live (non-void) prize — one per month
  // Prize from a game event (a weekly challenge or a live tournament — models/GameEvent)
  event?: Types.ObjectId;
  place?: number; // 1 = first
  eventPlace?: string; // "<event id>:<place>" while the prize stands (not void) — one per place
  // Withdrawal
  open?: boolean; // set while in progress — one per player at a time
  momo?: { network: MomoNetwork; number: string; accountName: string };
  reference?: string; // Paystack transfer reference
  transferCode?: string;
  failure?: string;
  note?: string;
  paidAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const walletTxnSchema = new Schema<IWalletTxn>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, enum: ["prize", "withdrawal"], required: true },
    amountGhs: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ["review", "available", "void", "requested", "sending", "otp", "paid", "failed", "rejected", "cancelled"],
      required: true,
    },
    game: { type: String },
    month: { type: String },
    score: { type: Number },
    availableAt: { type: Date },
    active: { type: Boolean },
    event: { type: Schema.Types.ObjectId, ref: "GameEvent" },
    place: { type: Number },
    eventPlace: { type: String },
    open: { type: Boolean },
    momo: {
      network: { type: String, enum: MOMO_NETWORKS },
      number: { type: String },
      accountName: { type: String },
    },
    reference: { type: String },
    transferCode: { type: String },
    failure: { type: String },
    note: { type: String },
    paidAt: { type: Date },
  },
  { timestamps: true }
);
walletTxnSchema.index({ user: 1, createdAt: -1 });
walletTxnSchema.index({ kind: 1, status: 1, availableAt: 1 });
// One live prize per game per month, and one withdrawal in progress per player.
walletTxnSchema.index({ game: 1, month: 1 }, { unique: true, partialFilterExpression: { active: true } });
// One standing prize per place in an event (event prizes never set `active`).
walletTxnSchema.index({ eventPlace: 1 }, { unique: true, partialFilterExpression: { eventPlace: { $exists: true } } });
walletTxnSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { open: true }, name: "one_open_withdrawal" });
walletTxnSchema.index({ reference: 1 }, { unique: true, partialFilterExpression: { reference: { $exists: true } } });
walletTxnSchema.index({ transferCode: 1 }, { partialFilterExpression: { transferCode: { $exists: true } } });

export const WalletTxn = model<IWalletTxn>("WalletTxn", walletTxnSchema);
