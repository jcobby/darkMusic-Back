import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { env } from "../config/env";
import { Donation } from "../models/Donation";
import { initializeTransaction, verifyTransaction } from "../services/paystack";
import { sendNotification } from "../services/mailer";

const isEmail = (v: unknown) => typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

/** POST /api/donate/initialize — start a Paystack donation payment. */
export async function initializeDonation(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, name, amountGhs, message } = req.body ?? {};
    if (!isEmail(email)) {
      return res.status(400).json({ message: "A valid email is required" });
    }
    const amount = Math.round(Number(amountGhs) * 100) / 100;
    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({ message: "Enter an amount of at least GH₵1" });
    }
    if (amount > 100000) {
      return res.status(400).json({ message: "Amount is too large" });
    }

    const reference = `DMY-DON-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

    await Donation.create({
      reference,
      email,
      name,
      amountGhs: amount,
      message,
      status: "pending",
    });

    const init = await initializeTransaction({
      email,
      amountGhs: amount,
      reference,
      callbackUrl: `${env.clientUrl}/support/callback`,
      metadata: { type: "donation", reference, name, message },
    });

    res.json({ authorizationUrl: init.authorizationUrl, reference, amountGhs: amount });
  } catch (err) {
    next(err);
  }
}

/** Marks a donation paid once (idempotent) + notifies the artist. */
export async function markDonationPaid(reference: string, paystackRef?: string) {
  const donation = await Donation.findOneAndUpdate(
    { reference, status: { $ne: "paid" } },
    { $set: { status: "paid", ...(paystackRef ? { paystackRef } : {}) } },
    { new: true }
  );
  if (donation) {
    void sendNotification(
      `💚 New donation — GH₵${donation.amountGhs}`,
      `From: ${donation.name || "Anonymous"} (${donation.email})\n` +
        (donation.message ? `Message: ${donation.message}\n` : "") +
        `Reference: ${donation.reference}`
    );
  }
  return donation;
}

/** GET /api/donate/verify?reference= */
export async function verifyDonation(req: Request, res: Response, next: NextFunction) {
  try {
    const reference = String(req.query.reference || "");
    const donation = await Donation.findOne({ reference });
    if (!donation) return res.status(404).json({ message: "Donation not found" });

    if (donation.status !== "paid") {
      const result = await verifyTransaction(reference);
      if (result.paid) {
        const updated = await markDonationPaid(reference, result.reference);
        if (updated) donation.status = updated.status;
      } else {
        await Donation.updateOne(
          { _id: donation._id, status: "pending" },
          { $set: { status: "failed" } }
        );
        donation.status = "failed";
      }
    }

    res.json({
      reference: donation.reference,
      status: donation.status,
      amountGhs: donation.amountGhs,
      name: donation.name || null,
    });
  } catch (err) {
    next(err);
  }
}
