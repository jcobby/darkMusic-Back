import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { env } from "../config/env";
import { Membership } from "../models/Membership";
import { User } from "../models/User";
import { Donation } from "../models/Donation";
import { initializeTransaction, verifyTransaction } from "../services/paystack";
import {
  TIERS,
  TIER_ORDER,
  MEMBER_DAYS,
  CUE_DESIGNS,
  isTier,
  isCueDesign,
  activeTier,
  tierAtLeast,
  cueFor,
  markMembershipPaid,
  type CueDesign,
} from "../services/membership";
import { bidderName } from "./auction.controller";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

/** The plans as the membership page shows them. */
const plans = () => ({
  days: MEMBER_DAYS,
  tiers: TIER_ORDER.map((key) => ({ key, ...TIERS[key] })),
  cues: (Object.keys(CUE_DESIGNS) as CueDesign[]).map((key) => ({ key, label: CUE_DESIGNS[key].label, tier: CUE_DESIGNS[key].tier })),
});

/** GET /api/membership — public: the tiers, prices and perks. */
export async function membershipPlans(_req: Request, res: Response) {
  res.json(plans());
}

/** A fan's membership as their pages see it. */
const mine = (u: Parameters<typeof activeTier>[0] & Parameters<typeof cueFor>[0]) => ({
  tier: activeTier(u),
  until: u.memberUntil && activeTier(u) ? u.memberUntil : null,
  cue: cueFor(u),
});

/** GET /api/account/membership — their membership (if any), their cue, and the plans. */
export async function myMembership(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.fan?.id).select("memberTier memberUntil cueDesign");
    if (!user) throw httpError(404, "Account not found");
    res.json({ ...plans(), membership: mine(user) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/account/membership/initialize { tier } — pay for a month (Mobile Money or card via Paystack). */
export async function startMembership(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.fan?.id);
    if (!user) throw httpError(404, "Account not found");
    const tier = req.body?.tier;
    if (!isTier(tier)) throw httpError(400, "Pick Supporter, VIP or Legend");
    const amountGhs = TIERS[tier].priceGhs;
    const reference = `DMY-MEMBER-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    await Membership.create({ reference, user: String(user._id), email: user.email, tier, amountGhs, status: "pending" });
    const init = await initializeTransaction({
      email: user.email,
      amountGhs,
      reference,
      callbackUrl: `${env.clientUrl}/membership?reference=${reference}`,
      metadata: { type: "membership", reference, tier, userId: String(user._id) },
    });
    res.json({ authorizationUrl: init.authorizationUrl, reference, amountGhs });
  } catch (err) {
    next(err);
  }
}

/** GET /api/account/membership/verify?reference= — on return from Paystack: confirm and apply it. */
export async function verifyMembership(req: Request, res: Response, next: NextFunction) {
  try {
    const reference = String(req.query.reference || "");
    const payment = await Membership.findOne({ reference, user: req.fan?.id });
    if (!payment) throw httpError(404, "Payment not found");
    if (payment.status !== "paid") {
      const result = await verifyTransaction(reference);
      if (result.paid) {
        await markMembershipPaid(reference, result.reference);
        payment.status = "paid";
      } else {
        await Membership.updateOne({ _id: payment._id, status: "pending" }, { $set: { status: "failed" } });
        payment.status = "failed";
      }
    }
    const user = await User.findById(req.fan?.id).select("memberTier memberUntil cueDesign");
    res.json({ status: payment.status, tier: payment.tier, membership: user ? mine(user) : null });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/account/cue { design } — their Pool cue (the exclusive ones need VIP or Legend). */
export async function setCue(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.fan?.id);
    if (!user) throw httpError(404, "Account not found");
    const design = req.body?.design;
    if (!isCueDesign(design)) throw httpError(400, "Pick one of the cues");
    const need = CUE_DESIGNS[design].tier;
    if (need && !tierAtLeast(activeTier(user), need)) throw httpError(403, `The ${CUE_DESIGNS[design].label} cue is for VIPs and Legends`);
    user.cueDesign = design;
    await user.save();
    res.json(mine(user));
  } catch (err) {
    next(err);
  }
}

let wallCache: { at: number; value: unknown } | null = null;
/**
 * GET /api/supporters/wall — this month's Supporter Wall: members by tier (Legends first),
 * and donors who said yes to their name on it. Names shortened, as on the boards.
 */
export async function supporterWall(_req: Request, res: Response, next: NextFunction) {
  try {
    if (wallCache && Date.now() - wallCache.at < 60_000) return res.json(wallCache.value);
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [members, donations] = await Promise.all([
      // A membership that ran at any point this month
      User.find({ memberTier: { $exists: true }, memberUntil: { $gte: monthStart } }).select("name email memberTier memberUntil").sort({ memberUntil: -1 }).lean(),
      Donation.find({ status: "paid", showOnWall: true, updatedAt: { $gte: monthStart } }).select("name email").sort({ updatedAt: 1 }).lean(),
    ]);
    const byTier = (t: string) => members.filter((m) => m.memberTier === t).map((m) => bidderName(m.name));
    const memberEmails = new Set(members.map((m) => m.email.toLowerCase()));
    const seen = new Set<string>();
    const donors: string[] = [];
    for (const d of donations) {
      const key = d.email.toLowerCase();
      if (memberEmails.has(key) || seen.has(key) || !d.name?.trim()) continue;
      seen.add(key);
      donors.push(bidderName(d.name));
    }
    const value = { month: now.toISOString().slice(0, 7), legends: byTier("legend"), vips: byTier("vip"), supporters: byTier("supporter"), donors };
    wallCache = { at: Date.now(), value };
    res.json(value);
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/memberships — recent membership payments, and how many members there are now. */
export async function adminMemberships(_req: Request, res: Response, next: NextFunction) {
  try {
    const now = new Date();
    const [payments, active] = await Promise.all([
      Membership.find({ status: "paid" }).sort({ updatedAt: -1 }).limit(200).lean(),
      User.aggregate<{ _id: string; n: number }>([{ $match: { memberUntil: { $gt: now } } }, { $group: { _id: "$memberTier", n: { $sum: 1 } } }]),
    ]);
    const users = await User.find({ _id: { $in: payments.map((p) => p.user) } }).select("name email phone memberTier memberUntil").lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    res.json({
      active: Object.fromEntries(TIER_ORDER.map((t) => [t, active.find((a) => a._id === t)?.n ?? 0])),
      thisMonthGhs: payments.filter((p) => p.updatedAt >= monthStart).reduce((s, p) => s + p.amountGhs, 0),
      payments: payments.map((p) => {
        const u = byId.get(p.user);
        return {
          reference: p.reference,
          tier: p.tier,
          amountGhs: p.amountGhs,
          paidAt: p.updatedAt,
          until: p.until ?? null,
          name: u?.name ?? null,
          email: u?.email ?? p.email,
          phone: u?.phone ?? null,
          activeTier: u ? activeTier(u) : null,
          memberUntil: u?.memberUntil ?? null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
}
