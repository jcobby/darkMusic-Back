import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { Types } from "mongoose";
import { env } from "../config/env";
import { MerchProduct, IMerchProduct } from "../models/MerchProduct";
import { MerchBid } from "../models/MerchBid";
import { Order } from "../models/Order";
import { User } from "../models/User";
import { initializeTransaction } from "../services/paystack";
import { sendMail, sendNotification } from "../services/mailer";
import { renderEmail, renderText, EmailContent } from "../services/emailTemplates";
import { imageUrl } from "../utils/media";
import { publicAuction, minNextBid, isLive, hasEnded } from "../utils/serialize";

/** Bids in the last two minutes push the end back, so nobody can snipe at 0:01. */
const ANTI_SNIPE_MS = 2 * 60 * 1000;
/** How long the winner has to pay before DMY may offer it elsewhere. */
export const PAY_WITHIN_HOURS = 48;
const MAX_BID_GHS = 1_000_000;

const ghs = (n?: number | null) => `GH₵${(n ?? 0).toLocaleString("en-US")}`;
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const productLink = (m: IMerchProduct) => `${env.clientUrl}/merch/${m.slug}`;

/** "Kwame Mensah" → "Kwame M." — how bidders appear publicly. */
export function bidderName(name?: string | null): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Fan";
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}

async function email(to: string | null | undefined, c: EmailContent) {
  if (to) await sendMail(to, c.title, renderText(c), renderEmail(c)).catch(() => {});
}


/**
 * Announce an auction's result exactly once: email the winner (and DMY), or
 * tell DMY nobody bid. Claimed atomically so the sweeper and a page load can't
 * both send it.
 */
export async function closeAuction(m: IMerchProduct): Promise<void> {
  if (!hasEnded(m) || m.auction.closedAt) return;
  const claimed = await MerchProduct.findOneAndUpdate(
    { _id: m._id, "auction.enabled": true, "auction.endsAt": { $lte: new Date() }, "auction.closedAt": null },
    { $set: { "auction.closedAt": new Date() } },
    { new: true }
  );
  if (!claimed) return;
  const a = claimed.auction;
  if (!a.highBidder) {
    void sendNotification(
      `Auction ended with no bids — ${claimed.name}`,
      `Nobody bid on ${claimed.name}. Edit it in the admin Merch tab to run it again or sell it at a fixed price.`
    );
    return;
  }
  const winner = await User.findById(a.highBidder);
  void email(winner?.email, {
    title: `You won ${claimed.name}!`,
    intro: `Your bid of ${ghs(a.highBidGhs)} was the highest. Pay within ${PAY_WITHIN_HOURS} hours to secure it — we'll then contact you about delivery.`,
    pre: [`Item: ${claimed.name}`, a.highSize ? `Size: ${a.highSize}` : "", `Winning bid: ${ghs(a.highBidGhs)}`]
      .filter(Boolean)
      .join("\n"),
    button: { label: `Pay ${ghs(a.highBidGhs)}`, url: productLink(claimed) },
  });
  void sendNotification(
    `🔨 Auction won — ${claimed.name} · ${ghs(a.highBidGhs)}`,
    `Winner: ${winner?.name || a.highBidderName} (${winner?.email ?? "unknown"})` +
      (a.highSize ? `\nSize: ${a.highSize}` : "") +
      `\nBids: ${a.bidCount}\n\nThey've been asked to pay within ${PAY_WITHIN_HOURS} hours. The paid order will show in the admin Orders tab.`
  );
}

/** Close every auction whose time is up. Runs on a timer (see index.ts). */
export async function sweepAuctions(): Promise<void> {
  const due = await MerchProduct.find({
    "auction.enabled": true,
    "auction.endsAt": { $lte: new Date() },
    "auction.closedAt": null,
  }).limit(50);
  for (const m of due) await closeAuction(m).catch((err) => console.error("[auction] close failed:", err));
}

async function findAuctionProduct(slug: string) {
  const m = await MerchProduct.findOne({ slug, hidden: { $ne: true } });
  if (!m || !m.auction?.enabled || !m.auction.endsAt) throw httpError(404, "This item isn't up for auction");
  return m;
}

/** Everything the bidding panel needs; `you` is filled in for a signed-in fan. */
async function auctionView(m: IMerchProduct, userId?: string) {
  const bids = await MerchBid.find({ product: m._id }).sort({ createdAt: -1 }).limit(25);
  const a = m.auction;
  const leading = Boolean(userId && a.highBidder && String(a.highBidder) === userId);
  const myBest = userId
    ? (await MerchBid.findOne({ product: m._id, user: userId }).sort({ amountGhs: -1 }))?.amountGhs ?? null
    : null;
  const ended = hasEnded(m);
  return {
    auction: publicAuction(m),
    bids: bids.map((b) => ({
      name: b.name,
      amountGhs: b.amountGhs,
      at: b.createdAt,
      mine: Boolean(userId && String(b.user) === userId),
    })),
    you: userId
      ? {
          leading: leading && !ended,
          won: leading && ended,
          paid: leading && ended && Boolean(a.paidAt),
          myBestBidGhs: myBest,
          size: leading ? a.highSize ?? null : null,
        }
      : null,
  };
}

/** GET /api/merch/:slug/auction — live state + recent bids (optionally signed in). */
export async function getAuction(req: Request, res: Response, next: NextFunction) {
  try {
    let m = await findAuctionProduct(String(req.params.slug));
    if (hasEnded(m) && !m.auction.closedAt) {
      await closeAuction(m);
      m = (await MerchProduct.findById(m._id)) ?? m;
    }
    res.json(await auctionView(m, req.fan?.id));
  } catch (err) {
    next(err);
  }
}

/** POST /api/merch/:slug/bids — a signed-in, verified fan places a bid. */
export async function placeBid(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.fan?.id);
    if (!user) throw httpError(404, "Account not found");
    if (!user.emailVerified) throw httpError(403, "Confirm your email address before bidding — check your inbox.");

    const m = await findAuctionProduct(String(req.params.slug));
    if (!isLive(m)) throw httpError(409, "This auction has ended");
    if (m.stock < 1) throw httpError(409, "This item is no longer available");
    if (m.auction.highBidder && String(m.auction.highBidder) === String(user._id)) {
      throw httpError(409, "You're already the highest bidder");
    }

    const amount = Math.round(Number(req.body?.amountGhs));
    const min = minNextBid(m);
    if (!Number.isFinite(amount) || amount < min) throw httpError(400, `Bid at least ${ghs(min)}`);
    if (amount > MAX_BID_GHS) throw httpError(400, "That bid is too large");

    let size: string | undefined;
    if (m.sizes.length) {
      size = String(req.body?.size || "");
      if (!m.sizes.includes(size)) throw httpError(400, "Choose your size");
    }

    const now = new Date();
    const name = bidderName(user.name);
    const previousLeader = m.auction.highBidder;
    // Atomic: only wins if nobody has outbid this amount since we read it.
    const updated = await MerchProduct.findOneAndUpdate(
      {
        _id: m._id,
        "auction.enabled": true,
        "auction.endsAt": { $gt: now },
        $or: [
          { "auction.highBidGhs": null, "auction.startingBidGhs": { $lte: amount } },
          { "auction.highBidGhs": { $lte: amount - m.auction.minIncrementGhs } },
        ],
      },
      {
        $set: {
          "auction.highBidGhs": amount,
          "auction.highBidder": user._id,
          "auction.highBidderName": name,
          "auction.highSize": size ?? null,
        },
        $inc: { "auction.bidCount": 1 },
      },
      { new: true }
    );
    if (!updated) throw httpError(409, "Someone just bid higher — refresh and try again");

    await MerchBid.create({ product: m._id, user: user._id, name, amountGhs: amount, size });

    // Late bid → give everyone else a fair chance to respond.
    const snipeLine = new Date(now.getTime() + ANTI_SNIPE_MS);
    await MerchProduct.updateOne(
      { _id: m._id, "auction.endsAt": { $lt: snipeLine } },
      { $set: { "auction.endsAt": snipeLine } }
    );

    if (previousLeader && String(previousLeader) !== String(user._id)) {
      const prev = await User.findById(previousLeader);
      void email(prev?.email, {
        title: `You've been outbid on ${m.name}`,
        intro: `The highest bid is now ${ghs(amount)}. Bid again before the auction ends to win it.`,
        button: { label: "Bid again", url: productLink(m) },
      });
    }

    const fresh = (await MerchProduct.findById(m._id)) ?? updated;
    res.status(201).json(await auctionView(fresh, String(user._id)));
  } catch (err) {
    next(err);
  }
}

/** POST /api/merch/:slug/auction/pay — the winner starts Paystack checkout for their bid. */
export async function payAuction(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.fan?.id);
    if (!user) throw httpError(404, "Account not found");
    const m = await findAuctionProduct(String(req.params.slug));
    const a = m.auction;
    if (!hasEnded(m)) throw httpError(409, "The auction is still running");
    if (!a.highBidder || String(a.highBidder) !== String(user._id) || a.highBidGhs == null) {
      throw httpError(403, "Only the winning bidder can pay for this item");
    }
    if (a.paidAt) throw httpError(409, "You've already paid for this item");
    if (m.stock < 1) throw httpError(409, "This item is no longer available — DMY will contact you");
    await closeAuction(m); // make sure the result is recorded

    const reference = `DMY-AUC-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    await Order.create({
      reference,
      customerEmail: user.email,
      customerName: user.name,
      items: [
        {
          kind: "merch",
          refId: String(m._id),
          name: `${m.name} (auction win)`,
          amountGhs: a.highBidGhs,
          qty: 1,
          size: a.highSize || undefined,
        },
      ],
      totalGhs: a.highBidGhs,
      status: "pending",
      auctionProduct: String(m._id),
    });
    const init = await initializeTransaction({
      email: user.email,
      amountGhs: a.highBidGhs,
      reference,
      callbackUrl: `${env.clientUrl}/checkout/callback`,
      metadata: { type: "merch_auction", reference, productId: String(m._id) },
    });
    res.json({ authorizationUrl: init.authorizationUrl, reference, amountGhs: a.highBidGhs });
  } catch (err) {
    next(err);
  }
}

/** Called once an auction order is paid (from checkout fulfilment). */
export async function markAuctionPaid(productId: string): Promise<void> {
  if (!Types.ObjectId.isValid(productId)) return;
  await MerchProduct.updateOne(
    { _id: productId, "auction.paidAt": null },
    { $set: { "auction.paidAt": new Date() } }
  );
}

/** GET /api/account/bids — auctions the signed-in fan has bid on. */
export async function listMyBids(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan?.id);
    const mine = await MerchBid.aggregate<{ _id: Types.ObjectId; best: number; last: Date }>([
      { $match: { user: new Types.ObjectId(userId) } },
      { $group: { _id: "$product", best: { $max: "$amountGhs" }, last: { $max: "$createdAt" } } },
      { $sort: { last: -1 } },
      { $limit: 50 },
    ]);
    const products = await MerchProduct.find({ _id: { $in: mine.map((b) => b._id) } });
    const byId = new Map(products.map((p) => [String(p._id), p]));
    const out = mine
      .map((b) => {
        const m = byId.get(String(b._id));
        if (!m || !m.auction?.enabled || !m.auction.endsAt) return null;
        const leading = Boolean(m.auction.highBidder && String(m.auction.highBidder) === userId);
        const ended = hasEnded(m);
        const status = !ended
          ? leading
            ? "leading"
            : "outbid"
          : leading
          ? m.auction.paidAt
            ? "paid"
            : "won"
          : "lost";
        return {
          slug: m.slug,
          name: m.name,
          image: imageUrl(m.images?.[0]) ?? null,
          myBestBidGhs: b.best,
          highBidGhs: m.auction.highBidGhs ?? null,
          endsAt: m.auction.endsAt,
          status,
        };
      })
      .filter(Boolean);
    res.json(out);
  } catch (err) {
    next(err);
  }
}
