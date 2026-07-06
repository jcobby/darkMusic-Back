import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { env } from "../config/env";
import { StreamPass, IStreamPass } from "../models/StreamPass";
import { User } from "../models/User";
import { initializeTransaction, verifyTransaction } from "../services/paystack";

export const STREAM_PASS = { priceGhs: 15, days: 30 };

/** POST /api/account/stream-pass/initialize — start a Paystack payment for a pass. */
export async function initializeStreamPass(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.fan?.id);
    if (!user) return res.status(404).json({ message: "Account not found" });

    const reference = `DMY-PASS-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    await StreamPass.create({
      reference,
      user: String(user._id),
      email: user.email,
      amountGhs: STREAM_PASS.priceGhs,
      status: "pending",
    });

    const init = await initializeTransaction({
      email: user.email,
      amountGhs: STREAM_PASS.priceGhs,
      reference,
      callbackUrl: `${env.clientUrl}/account?pass=1`,
      metadata: { type: "stream_pass", reference, userId: String(user._id) },
    });

    res.json({ authorizationUrl: init.authorizationUrl, reference, amountGhs: STREAM_PASS.priceGhs });
  } catch (err) {
    next(err);
  }
}

/**
 * Claim a pass payment exactly once and extend the fan's streaming access by 30
 * days (from whichever is later — now or their current expiry). Returns the pass
 * if the reference belongs to a pass (whether just claimed or already paid),
 * else null — so the webhook can fall through to other payment types.
 */
export async function markStreamPassPaid(
  reference: string,
  paystackRef?: string
): Promise<IStreamPass | null> {
  const claimed = await StreamPass.findOneAndUpdate(
    { reference, status: { $ne: "paid" } },
    { $set: { status: "paid", ...(paystackRef ? { paystackRef } : {}) } },
    { new: true }
  );
  if (claimed) {
    const user = await User.findById(claimed.user);
    if (user) {
      const base = user.streamUntil && user.streamUntil > new Date() ? user.streamUntil : new Date();
      user.streamUntil = new Date(base.getTime() + STREAM_PASS.days * 24 * 60 * 60 * 1000);
      await user.save();
    }
    return claimed;
  }
  return StreamPass.findOne({ reference }); // already paid, or not a pass (null)
}

/** GET /api/account/stream-pass/verify?reference= — confirm + grant on return. */
export async function verifyStreamPass(req: Request, res: Response, next: NextFunction) {
  try {
    const reference = String(req.query.reference || "");
    const pass = await StreamPass.findOne({ reference, user: req.fan?.id });
    if (!pass) return res.status(404).json({ message: "Pass not found" });

    if (pass.status !== "paid") {
      const result = await verifyTransaction(reference);
      if (result.paid) {
        await markStreamPassPaid(reference, result.reference);
        pass.status = "paid";
      } else {
        await StreamPass.updateOne(
          { _id: pass._id, status: "pending" },
          { $set: { status: "failed" } }
        );
        pass.status = "failed";
      }
    }

    const user = await User.findById(req.fan?.id);
    res.json({
      status: pass.status,
      streamUntil: user?.streamUntil ? user.streamUntil.toISOString() : null,
    });
  } catch (err) {
    next(err);
  }
}
