import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { Types } from "mongoose";
import { env } from "../config/env";
import { User } from "../models/User";
import { GameScore } from "../models/GameScore";
import {
  PrizeDeposit,
  WalletTxn,
  MOMO_NETWORKS,
  PAYSTACK_MOMO_CODE,
  OPEN_WITHDRAWAL,
  type IWalletTxn,
  type MomoNetwork,
} from "../models/Wallet";
import { initializeTransaction, verifyTransaction, createTransferRecipient, initiateTransfer, finalizeTransfer } from "../services/paystack";
import { sendNotification } from "../services/mailer";
import {
  GAME_PRIZE,
  REVIEW_HOURS,
  email,
  ghs,
  isMonth,
  maskMomo,
  markPrizeDepositPaid,
  monthEnd,
  monthLabel,
  monthOf,
  normalizeMomo,
  poolFor,
  walletBalance,
  withdrawalPaidEmail,
} from "../services/prizes";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const assertPrizeGame = (game: string) => {
  if (game !== GAME_PRIZE.game) throw httpError(404, "This game has no prize");
};

// ---------- Public: the prize pool and past winners ----------

/** GET /api/games/:game/prize?month= — the pool (with every deposit), past winners and what's been paid out. */
export async function prizePool(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const month = isMonth(req.query.month) ? String(req.query.month) : monthOf();
    const pool = await poolFor(game, month);

    // Past winners, newest first, with where their prize is up to.
    const prizes = await WalletTxn.find({ kind: "prize", game, active: true }).sort({ month: -1 }).limit(12);
    const userIds = [...new Set(prizes.map((p) => String(p.user)))];
    const paidByUser = new Map<string, { paid: number; open: number }>();
    for (const id of userIds) {
      const rows = await WalletTxn.aggregate<{ _id: string; sum: number }>([
        { $match: { user: new Types.ObjectId(id), kind: "withdrawal", status: { $in: ["paid", ...OPEN_WITHDRAWAL] } } },
        { $group: { _id: { $cond: [{ $eq: ["$status", "paid"] }, "paid", "open"] }, sum: { $sum: "$amountGhs" } } },
      ]);
      paidByUser.set(id, {
        paid: rows.find((r) => r._id === "paid")?.sum ?? 0,
        open: rows.find((r) => r._id === "open")?.sum ?? 0,
      });
    }
    // Withdrawals pay off a player's oldest prizes first.
    const oldestFirst = [...prizes].sort((a, b) => String(a.month).localeCompare(String(b.month)));
    const state = new Map<string, string>();
    for (const p of oldestFirst) {
      const left = paidByUser.get(String(p.user))!;
      if (p.status === "review") state.set(String(p._id), "checking");
      else if (left.paid + 0.001 >= p.amountGhs) {
        state.set(String(p._id), "paid");
        left.paid -= p.amountGhs;
      } else if (left.open + left.paid + 0.001 >= p.amountGhs) {
        state.set(String(p._id), "withdrawing");
        left.open -= p.amountGhs - left.paid;
        left.paid = 0;
      } else state.set(String(p._id), "in_wallet");
    }
    const names = await GameScore.find({ $or: prizes.map((p) => ({ game, month: p.month, user: p.user })) }).select("month user name");
    const nameOf = (p: IWalletTxn) => names.find((n) => n.month === p.month && String(n.user) === String(p.user))?.name ?? "Player";

    const paidOut = await WalletTxn.aggregate<{ sum: number }>([
      { $match: { kind: "withdrawal", status: "paid" } },
      { $group: { _id: null, sum: { $sum: "$amountGhs" } } },
    ]);

    res.json({
      game,
      month,
      endsAt: monthEnd(month),
      reviewHours: REVIEW_HOURS,
      pool: {
        prizeGhs: pool.prizeGhs,
        depositedGhs: pool.depositedGhs,
        funded: pool.funded,
        announcedGhs: GAME_PRIZE.prizeGhs,
        deposits: pool.deposits.map((d) => ({ amountGhs: d.amountGhs, paidAt: d.paidAt, ref: d.reference.slice(-6).toUpperCase() })),
      },
      winners: prizes.map((p) => ({
        month: p.month,
        name: nameOf(p),
        score: p.score ?? null,
        amountGhs: p.amountGhs,
        status: state.get(String(p._id)),
        availableAt: p.availableAt ?? null,
      })),
      totalPaidOutGhs: Math.round((paidOut[0]?.sum ?? 0) * 100) / 100,
    });
  } catch (err) {
    next(err);
  }
}

// ---------- Player: wallet ----------

const txnView = (t: IWalletTxn) => ({
  id: String(t._id),
  kind: t.kind,
  amountGhs: t.amountGhs,
  status: t.status,
  month: t.month ?? null,
  score: t.score ?? null,
  availableAt: t.availableAt ?? null,
  momo: t.momo?.number ? { network: t.momo.network, number: maskMomo(t.momo.number), accountName: t.momo.accountName } : null,
  note: t.note ?? null,
  failure: t.failure ?? null,
  paidAt: t.paidAt ?? null,
  createdAt: t.createdAt,
});

/** GET /api/wallet — balance (withdrawable now / in the score check) and history. */
export async function myWallet(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan?.id);
    const [balance, txns] = await Promise.all([
      walletBalance(userId),
      WalletTxn.find({ user: userId, status: { $ne: "void" } }).sort({ createdAt: -1 }).limit(30),
    ]);
    res.json({ ...balance, reviewHours: REVIEW_HOURS, txns: txns.map(txnView) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/wallet/withdraw { network, number, accountName } — withdraw the whole available balance to Mobile Money. */
export async function requestWithdrawal(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan?.id);
    const network = String(req.body?.network || "") as MomoNetwork;
    if (!MOMO_NETWORKS.includes(network)) throw httpError(400, "Choose your Mobile Money network");
    const number = normalizeMomo(req.body?.number);
    if (!number) throw httpError(400, "Enter a valid Ghana Mobile Money number, e.g. 024 123 4567");
    const accountName = String(req.body?.accountName || "").trim().replace(/\s+/g, " ").slice(0, 80);
    if (accountName.length < 3) throw httpError(400, "Enter the name on the Mobile Money account");

    const { availableGhs } = await walletBalance(userId);
    if (availableGhs <= 0) throw httpError(400, "There's nothing in your wallet to withdraw yet");

    let w: IWalletTxn;
    try {
      w = await WalletTxn.create({
        user: userId,
        kind: "withdrawal",
        amountGhs: availableGhs,
        status: "requested",
        open: true,
        momo: { network, number, accountName },
      });
    } catch {
      throw httpError(409, "You already have a withdrawal in progress");
    }

    const user = await User.findById(userId);
    void sendNotification(
      `💸 Prize withdrawal request — ${ghs(availableGhs)}`,
      `${user?.name || "A player"} (${user?.email ?? "unknown"}) wants to withdraw ${ghs(availableGhs)}.\n\n` +
        `Mobile Money: ${network} ${number}\nAccount name: ${accountName}\n\n` +
        `Open admin → Game Prize → Withdrawals and press "Send" — Paystack pays it to their MoMo.`
    ).catch(() => {});
    void email(user?.email, {
      title: "We've got your withdrawal request",
      intro:
        `${ghs(availableGhs)} is on its way to ${network} Mobile Money ${maskMomo(number)} (${accountName}). ` +
        `DMY approves it and Paystack sends it — we'll email you the moment it's sent.`,
      button: { label: "See my wallet", url: `${env.clientUrl}/account#wallet` },
    });
    res.status(201).json(txnView(w));
  } catch (err) {
    next(err);
  }
}

/** POST /api/wallet/withdrawals/:id/cancel — change your mind (or fix a wrong number) before DMY sends it. */
export async function cancelWithdrawal(req: Request, res: Response, next: NextFunction) {
  try {
    if (!Types.ObjectId.isValid(String(req.params.id))) throw httpError(404, "Not found");
    const w = await WalletTxn.findOneAndUpdate(
      { _id: req.params.id, user: req.fan?.id, kind: "withdrawal", status: "requested" },
      { $set: { status: "cancelled" }, $unset: { open: "" } },
      { new: true }
    );
    if (!w) throw httpError(409, "This withdrawal is already being sent and can't be cancelled");
    res.json(txnView(w));
  } catch (err) {
    next(err);
  }
}

// ---------- Admin: deposits ----------

/** GET /api/admin/games/:game/deposits?month= */
export async function listDeposits(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const month = isMonth(req.query.month) ? String(req.query.month) : monthOf();
    const [pool, all] = await Promise.all([poolFor(game, month), PrizeDeposit.find({ game, month }).sort({ createdAt: -1 }).limit(50)]);
    res.json({
      month,
      prizeGhs: pool.prizeGhs,
      depositedGhs: pool.depositedGhs,
      funded: pool.funded,
      deposits: all.map((d) => ({ amountGhs: d.amountGhs, status: d.status, reference: d.reference, paidAt: d.paidAt ?? null, createdAt: d.createdAt, by: d.by ?? null })),
    });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/games/:game/deposits { amountGhs, month } — pay money into a month's prize pool via Paystack. */
export async function startDeposit(req: Request, res: Response, next: NextFunction) {
  try {
    const game = String(req.params.game);
    assertPrizeGame(game);
    const month = isMonth(req.body?.month) ? String(req.body.month) : monthOf();
    if (monthEnd(month).getTime() <= Date.now()) throw httpError(400, "That month has already ended — deposit into this month or a coming one");
    const amountGhs = Math.round(Number(req.body?.amountGhs) * 100) / 100;
    if (!Number.isFinite(amountGhs) || amountGhs < 1 || amountGhs > 100000) throw httpError(400, "Enter an amount between GH₵1 and GH₵100,000");

    const reference = `DMY-PRIZE-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    await PrizeDeposit.create({ game, month, amountGhs, reference, status: "pending", by: req.admin?.email });
    const init = await initializeTransaction({
      email: req.admin?.email || env.adminEmail,
      amountGhs,
      reference,
      callbackUrl: `${env.clientUrl}/admin?prizeDeposit=${reference}`,
      metadata: { type: "prize_deposit", game, month },
    });
    res.json({ authorizationUrl: init.authorizationUrl, reference });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/games/:game/deposits/verify?reference= — after Paystack sends the admin back. */
export async function verifyDeposit(req: Request, res: Response, next: NextFunction) {
  try {
    const reference = String(req.query.reference || "");
    const dep = await PrizeDeposit.findOne({ reference });
    if (!dep) throw httpError(404, "Deposit not found");
    if (dep.status !== "paid") {
      const r = await verifyTransaction(reference);
      if (r.paid) await markPrizeDepositPaid(reference, r.amountGhs);
      else await PrizeDeposit.updateOne({ _id: dep._id, status: "pending" }, { $set: { status: "failed" } });
    }
    const fresh = await PrizeDeposit.findById(dep._id);
    const pool = await poolFor(dep.game, dep.month);
    res.json({ status: fresh?.status, amountGhs: dep.amountGhs, month: dep.month, poolGhs: pool.depositedGhs });
  } catch (err) {
    next(err);
  }
}

// ---------- Admin: withdrawals ----------

/** GET /api/admin/wallet/withdrawals — newest first, with the player and the prizes behind their balance. */
export async function adminWithdrawals(_req: Request, res: Response, next: NextFunction) {
  try {
    const list = await WalletTxn.find({ kind: "withdrawal", status: { $ne: "cancelled" } })
      .sort({ createdAt: -1 })
      .limit(60)
      .populate<{ user: { _id: Types.ObjectId; name?: string; email: string; phone?: string } }>("user", "name email phone");
    // Monthly prizes (`active`) and event prizes (`eventPlace`) that stand
    const prizes = await WalletTxn.find({
      kind: "prize",
      $or: [{ active: true }, { eventPlace: { $exists: true } }],
      user: { $in: list.map((w) => w.user?._id).filter(Boolean) },
    });
    res.json(
      list.map((w) => ({
        id: String(w._id),
        amountGhs: w.amountGhs,
        status: w.status,
        momo: w.momo ?? null,
        reference: w.reference ?? null,
        failure: w.failure ?? null,
        note: w.note ?? null,
        paidAt: w.paidAt ?? null,
        createdAt: w.createdAt,
        player: w.user ? { id: String(w.user._id), name: w.user.name ?? null, email: w.user.email, phone: w.user.phone ?? null } : null,
        prizes: prizes
          .filter((p) => w.user && String(p.user) === String(w.user._id))
          .map((p) => ({ month: p.month ?? null, event: p.event ? (p.note ?? "Event") : null, amountGhs: p.amountGhs, score: p.score ?? null, status: p.status })),
      }))
    );
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/wallet/withdrawals/:id/send — DMY approves; Paystack pays the player's MoMo. */
export async function sendWithdrawal(req: Request, res: Response, next: NextFunction) {
  try {
    if (!Types.ObjectId.isValid(String(req.params.id))) throw httpError(404, "Not found");
    // Claim it so a double-click can't pay twice.
    const w = await WalletTxn.findOneAndUpdate(
      { _id: req.params.id, kind: "withdrawal", status: { $in: ["requested", "failed"] } },
      { $set: { status: "sending", open: true, reference: `dmy-wd-${Date.now()}-${crypto.randomBytes(4).toString("hex")}` }, $unset: { failure: "" } },
      { new: true }
    );
    if (!w || !w.momo?.number) throw httpError(409, "This withdrawal isn't waiting to be sent");
    try {
      const recipient = await createTransferRecipient({
        name: w.momo.accountName,
        accountNumber: w.momo.number,
        bankCode: PAYSTACK_MOMO_CODE[w.momo.network],
      });
      const t = await initiateTransfer({
        amountGhs: w.amountGhs,
        recipientCode: recipient,
        reference: w.reference!,
        reason: `DMY Beat Breaker prize`,
      });
      const status = t.status === "success" ? "paid" : t.status === "otp" ? "otp" : t.status === "failed" ? "failed" : "sending";
      const done = await WalletTxn.findByIdAndUpdate(
        w._id,
        {
          $set: { status, transferCode: t.transferCode, ...(status === "paid" ? { paidAt: new Date() } : {}) },
          ...(status === "paid" || status === "failed" ? { $unset: { open: "" } } : {}),
        },
        { new: true }
      );
      if (status === "paid" && done) await withdrawalPaidEmail(done);
      res.json({
        status,
        message:
          status === "otp"
            ? "Paystack sent you an OTP — enter it to release the money."
            : status === "paid"
            ? "Sent ✓"
            : status === "failed"
            ? "Paystack rejected the transfer."
            : "Sending — Paystack will confirm shortly.",
      });
    } catch (err) {
      // Nothing left Paystack — put it back to waiting, with the reason.
      const why = err instanceof Error ? err.message : "Paystack transfer failed";
      await WalletTxn.updateOne({ _id: w._id }, { $set: { status: "requested", failure: why } });
      throw httpError(502, `Paystack: ${why}`);
    }
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/wallet/withdrawals/:id/otp { otp } — release a transfer waiting for the owner's OTP. */
export async function finalizeWithdrawal(req: Request, res: Response, next: NextFunction) {
  try {
    if (!Types.ObjectId.isValid(String(req.params.id))) throw httpError(404, "Not found");
    const otp = String(req.body?.otp || "").trim();
    if (!/^\d{4,8}$/.test(otp)) throw httpError(400, "Enter the OTP Paystack sent you");
    const w = await WalletTxn.findOne({ _id: req.params.id, kind: "withdrawal", status: "otp" });
    if (!w?.transferCode) throw httpError(409, "This withdrawal isn't waiting for an OTP");
    const r = await finalizeTransfer(w.transferCode, otp);
    const paid = r.status === "success";
    const done = await WalletTxn.findByIdAndUpdate(
      w._id,
      { $set: { status: paid ? "paid" : "sending", ...(paid ? { paidAt: new Date() } : {}) }, ...(paid ? { $unset: { open: "" } } : {}) },
      { new: true }
    );
    if (paid && done) await withdrawalPaidEmail(done);
    res.json({ status: paid ? "paid" : "sending", message: paid ? "Sent ✓" : "Sending — Paystack will confirm shortly." });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/wallet/withdrawals/:id/mark-paid { note } — paid outside Paystack (e.g. MoMo by hand). */
export async function markWithdrawalPaid(req: Request, res: Response, next: NextFunction) {
  try {
    if (!Types.ObjectId.isValid(String(req.params.id))) throw httpError(404, "Not found");
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 200) : undefined;
    const w = await WalletTxn.findOneAndUpdate(
      { _id: req.params.id, kind: "withdrawal", status: { $in: ["requested", "failed", "otp", "sending"] } },
      { $set: { status: "paid", paidAt: new Date(), ...(note ? { note } : {}) }, $unset: { open: "", failure: "" } },
      { new: true }
    );
    if (!w) throw httpError(409, "This withdrawal can't be marked paid");
    await withdrawalPaidEmail(w);
    res.json({ status: "paid" });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/wallet/withdrawals/:id/reject { reason } — decline it; the money goes back into their wallet. */
export async function rejectWithdrawal(req: Request, res: Response, next: NextFunction) {
  try {
    if (!Types.ObjectId.isValid(String(req.params.id))) throw httpError(404, "Not found");
    const reason = String(req.body?.reason || "").trim().slice(0, 200);
    if (reason.length < 3) throw httpError(400, "Say why, so the player knows what to fix");
    const w = await WalletTxn.findOneAndUpdate(
      { _id: req.params.id, kind: "withdrawal", status: { $in: ["requested", "failed"] } },
      { $set: { status: "rejected", note: reason }, $unset: { open: "" } },
      { new: true }
    );
    if (!w) throw httpError(409, "This withdrawal can't be rejected now");
    const user = await User.findById(w.user);
    void email(user?.email, {
      title: "Your withdrawal needs another look",
      intro: `DMY couldn't send your ${ghs(w.amountGhs)} withdrawal: ${reason}. The money is still in your DMY wallet — fix the details and withdraw again.`,
      button: { label: "Open my wallet", url: `${env.clientUrl}/account#wallet` },
    });
    res.json({ status: "rejected" });
  } catch (err) {
    next(err);
  }
}
