import { Types } from "mongoose";
import { env } from "../config/env";
import { GameScore } from "../models/GameScore";
import { User } from "../models/User";
import { PrizeDeposit, WalletTxn, SPENDING_WITHDRAWAL, type IWalletTxn } from "../models/Wallet";
import { sendMail, sendNotification } from "./mailer";
import { renderEmail, renderText, type EmailContent } from "./emailTemplates";
import { isDailyMonth } from "./gameScoring";

/**
 * The monthly game prize, start to finish:
 *  1. DMY pays money into the month's prize POOL through Paystack (PrizeDeposit) —
 *     players see every deposit. With no deposit yet, the announced amount stands.
 *  2. When the month ends, the top of the board (not disqualified) gets the pool as a
 *     prize in their DMY WALLET, held for a score check (REVIEW_HOURS). How the board
 *     adds up is in services/gameScoring.
 *  3. Then it's available: they withdraw it to Mobile Money, DMY approves, and
 *     Paystack sends it (see prize.controller).
 */
export const GAME_PRIZE = { game: "beat-breaker", prizeGhs: 500 } as const;
export const REVIEW_HOURS = 48;

// ---------- Months (UTC = Ghana time) ----------
export const monthOf = (d = new Date()) => d.toISOString().slice(0, 7);
/** The month before this one — the latest whose prize can be settled. */
export const prevMonth = (d = new Date()) => monthOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)));
/** First instant of the next month. */
export const monthEnd = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1));
};
export const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
export const isMonth = (v: unknown): v is string => /^\d{4}-\d{2}$/.test(String(v || ""));

/** Rows that count on a month's board: played that month and not disqualified. */
export const ranked = (game: string, month: string) => ({ game, month, score: { $gt: 0 }, disqualified: { $ne: true } });
export const BOARD_ORDER = { score: -1, achievedAt: 1 } as const; // a tie goes to whoever got there first

export const ghs = (n: number) => `GH₵${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
const when = (d: Date) =>
  d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Accra" });

export async function email(to: string | null | undefined, c: EmailContent) {
  if (to) await sendMail(to, c.title, renderText(c), renderEmail(c)).catch(() => {});
}

// ---------- The pool ----------

/** Paid deposits for a month, and the prize they add up to (the announced amount until DMY deposits). */
export async function poolFor(game: string, month: string) {
  const deposits = await PrizeDeposit.find({ game, month, status: "paid" }).sort({ paidAt: 1 });
  const depositedGhs = round2(deposits.reduce((s, d) => s + d.amountGhs, 0));
  return {
    deposits,
    depositedGhs,
    funded: depositedGhs > 0,
    prizeGhs: depositedGhs > 0 ? depositedGhs : GAME_PRIZE.prizeGhs,
  };
}

/** Called for every successful Paystack charge: is it a prize-pool deposit? (Idempotent.) */
export async function markPrizeDepositPaid(reference: string, amountGhs: number): Promise<boolean> {
  const dep = await PrizeDeposit.findOne({ reference });
  if (!dep) return false;
  if (dep.status === "paid") return true;
  if (amountGhs + 0.001 < dep.amountGhs) {
    void sendNotification(
      `⚠️ Prize deposit underpaid — ${reference}`,
      `Paystack reported ${ghs(amountGhs)} for a ${ghs(dep.amountGhs)} prize deposit, so it wasn't added to the pool.`
    ).catch(() => {});
    return true;
  }
  const done = await PrizeDeposit.findOneAndUpdate(
    { _id: dep._id, status: { $ne: "paid" } },
    { $set: { status: "paid", paidAt: new Date() } },
    { new: true }
  );
  if (done) {
    const pool = await poolFor(done.game, done.month);
    void sendNotification(
      `💰 Prize pool deposit received — ${ghs(done.amountGhs)}`,
      `${ghs(done.amountGhs)} is in the Beat Breaker prize pool for ${monthLabel(done.month)} (now ${ghs(pool.depositedGhs)}). Players can see it on the leaderboard.`
    ).catch(() => {});
  }
  return true;
}

// ---------- Wallets ----------

/** What a player can withdraw now, and what's still in the score check. */
export async function walletBalance(userId: string | Types.ObjectId) {
  const rows = await WalletTxn.aggregate<{ _id: { kind: string; status: string }; sum: number }>([
    { $match: { user: new Types.ObjectId(String(userId)) } },
    { $group: { _id: { kind: "$kind", status: "$status" }, sum: { $sum: "$amountGhs" } } },
  ]);
  const sum = (kind: string, statuses: string[]) =>
    rows.filter((r) => r._id.kind === kind && statuses.includes(r._id.status)).reduce((s, r) => s + r.sum, 0);
  const won = sum("prize", ["available"]);
  const spent = sum("withdrawal", SPENDING_WITHDRAWAL);
  return {
    availableGhs: round2(Math.max(0, won - spent)),
    inReviewGhs: round2(sum("prize", ["review"])),
    withdrawnGhs: round2(sum("withdrawal", ["paid"])),
  };
}

// ---------- End of the month ----------

/**
 * Once a month is over, its prize goes to the top score that wasn't disqualified,
 * into their wallet for the score check. Safe to call again — it only acts once.
 */
export async function settlePrize(game: string, month: string): Promise<void> {
  if (monthEnd(month).getTime() > Date.now()) return;
  if (await WalletTxn.exists({ kind: "prize", game, month, active: true })) return;
  const winner = await GameScore.findOne(ranked(game, month)).sort(BOARD_ORDER);
  if (!winner) return;
  const { prizeGhs, funded } = await poolFor(game, month);
  const availableAt = new Date(Math.max(Date.now(), monthEnd(month).getTime()) + REVIEW_HOURS * 3600e3);
  try {
    await WalletTxn.create({
      user: winner.user,
      kind: "prize",
      amountGhs: prizeGhs,
      status: "review",
      game,
      month,
      score: winner.score,
      availableAt,
      active: true,
    });
  } catch {
    return; // settled at the same moment elsewhere (unique index)
  }
  const user = await User.findById(winner.user);
  const label = monthLabel(month);
  const pts = winner.score.toLocaleString("en-US");
  const daily = isDailyMonth(month);
  void email(user?.email, {
    title: `You won ${ghs(prizeGhs)}! 🏆`,
    intro:
      (daily
        ? `You finished ${label} on top of the Beat Breaker board — ${pts} points over ${winner.days ?? 0} days. `
        : `You finished ${label} with the top Beat Breaker score (${pts}). `) +
      `${ghs(prizeGhs)} is now in your DMY wallet. After a quick score check you can withdraw it to Mobile Money — from ${when(availableAt)}.`,
    button: { label: "See my wallet", url: `${env.clientUrl}/account#wallet` },
  });
  void sendNotification(
    `🏆 Beat Breaker winner — ${label}`,
    `${user?.name || winner.name} (${user?.email ?? "unknown"}) won ${ghs(prizeGhs)} with ${winner.score} points ` +
      (daily
        ? `(${winner.days ?? 0} days played, best game ${winner.bestRun ?? 0}, level ${winner.level}, ${winner.runs} runs).`
        : `(level ${winner.level}, ${winner.runs} runs).`) +
      `${funded ? "" : "\n⚠️ Nothing was deposited into this month's pool — the announced amount was credited. Deposit it from admin → Game Prize before they withdraw."}\n` +
      `It's in their wallet for a ${REVIEW_HOURS}-hour score check (until ${when(availableAt)}). Check the scores in admin → Game Prize; disqualify there if something's wrong.`
  ).catch(() => {});
}

/** Score check over: the prize can be withdrawn. Emails the winner once. */
export async function releasePrizes(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const p = await WalletTxn.findOneAndUpdate(
      { kind: "prize", status: "review", availableAt: { $lte: new Date() } },
      { $set: { status: "available" } },
      { new: true }
    );
    if (!p) return;
    const user = await User.findById(p.user);
    // An event prize's note names the event and the place
    const what = p.event ? `${p.note ?? "event"} prize` : `${monthLabel(p.month ?? "")} Beat Breaker prize`;
    void email(user?.email, {
      title: `Your ${ghs(p.amountGhs)} is ready to withdraw`,
      intro: `The score check for your ${what} is done. Withdraw it to your Mobile Money from your DMY wallet.`,
      button: { label: "Withdraw now", url: `${env.clientUrl}/account#wallet` },
    });
  }
}

/** Run by the server every minute: settle last month's prize as soon as it ends, and release checked prizes. */
export async function sweepGamePrizes(): Promise<void> {
  await settlePrize(GAME_PRIZE.game, prevMonth());
  await releasePrizes();
}

/** Can this prize still be taken back? Only if it hasn't been withdrawn. */
export async function voidable(p: IWalletTxn): Promise<boolean> {
  if (p.status === "review") return true;
  if (p.status !== "available") return false;
  const { availableGhs } = await walletBalance(p.user);
  return availableGhs + 0.001 >= p.amountGhs;
}

/**
 * After DMY disqualifies (or restores) a score in a finished month: if the prize
 * sits with someone who's no longer on top, take it back and give it to the new
 * winner. Returns a message if it can't (already withdrawn).
 */
export async function reassessWinner(game: string, month: string): Promise<{ ok: boolean; message?: string }> {
  if (monthEnd(month).getTime() > Date.now()) return { ok: true };
  const prize = await WalletTxn.findOne({ kind: "prize", game, month, active: true });
  const top = await GameScore.findOne(ranked(game, month)).sort(BOARD_ORDER);
  if (prize && top && String(prize.user) === String(top.user)) return { ok: true };
  if (prize) {
    if (!(await voidable(prize))) {
      return { ok: false, message: "The winner has already withdrawn (or is withdrawing) this prize — reject the withdrawal first." };
    }
    await WalletTxn.updateOne({ _id: prize._id, active: true }, { $set: { status: "void" }, $unset: { active: "" } });
    const user = await User.findById(prize.user);
    void email(user?.email, {
      title: `Update on your ${monthLabel(month)} Beat Breaker prize`,
      intro: "After DMY's review of the top scores, your score didn't qualify for this month's prize, so it has been removed from your wallet. Contact DMY if you think this is a mistake.",
    });
  }
  await settlePrize(game, month);
  return { ok: true };
}

// ---------- Paystack transfer results (webhook) ----------

/** transfer.success / transfer.failed / transfer.reversed → update the withdrawal. Returns true if it was ours. */
export async function applyTransferEvent(event: string, data: { reference?: string; transfer_code?: string; reason?: string }) {
  const w = await WalletTxn.findOne({
    kind: "withdrawal",
    $or: [{ reference: data.reference ?? "-" }, { transferCode: data.transfer_code ?? "-" }],
  });
  if (!w) return false;
  if (event === "transfer.success") {
    const done = await WalletTxn.findOneAndUpdate(
      { _id: w._id, status: { $ne: "paid" } },
      { $set: { status: "paid", paidAt: new Date() }, $unset: { open: "", failure: "" } },
      { new: true }
    );
    if (done) await withdrawalPaidEmail(done);
  } else if (event === "transfer.failed" || event === "transfer.reversed") {
    const why = event === "transfer.reversed" ? "Paystack reversed the transfer" : "Paystack couldn't complete the transfer";
    await WalletTxn.updateOne({ _id: w._id, status: { $ne: "paid" } }, { $set: { status: "failed", failure: why }, $unset: { open: "" } });
    void sendNotification(
      `⚠️ Prize withdrawal failed — ${ghs(w.amountGhs)}`,
      `${why} (${w.momo?.network} ${w.momo?.number}, ${w.momo?.accountName}). The money is back in the player's wallet. Check Paystack, then press Send again in admin → Game Prize.`
    ).catch(() => {});
  }
  return true;
}

export async function withdrawalPaidEmail(w: IWalletTxn) {
  const user = await User.findById(w.user);
  void email(user?.email, {
    title: `${ghs(w.amountGhs)} sent to your Mobile Money 🎉`,
    intro: `Your Beat Breaker prize withdrawal is done — ${ghs(w.amountGhs)} to ${w.momo?.network} ${maskMomo(w.momo?.number)} (${w.momo?.accountName}). See you on the board this month!`,
    button: { label: "Play Beat Breaker", url: `${env.clientUrl}/games/beat-breaker` },
  });
}

/** "0241234567" → "024 •••• 567" */
export const maskMomo = (n?: string) => (n ? `${n.slice(0, 3)} •••• ${n.slice(-3)}` : "");

/** Accepts 024 123 4567, +233 24 123 4567, 233241234567 … → "0241234567", or null. */
export function normalizeMomo(v: unknown): string | null {
  let d = String(v ?? "").replace(/\D/g, "");
  if (d.startsWith("233") && d.length === 12) d = `0${d.slice(3)}`;
  else if (d.length === 9) d = `0${d}`;
  return /^0[25]\d{8}$/.test(d) ? d : null;
}
