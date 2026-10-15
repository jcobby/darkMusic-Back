import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { Types } from "mongoose";
import { env } from "../config/env";
import { MerchProduct, IMerchProduct, AUCTION_RUN_DAYS } from "../models/MerchProduct";
import { MerchBid } from "../models/MerchBid";
import { Order } from "../models/Order";
import { User } from "../models/User";
import { initializeTransaction } from "../services/paystack";
import { sendMail, sendNotification } from "../services/mailer";
import { renderEmail, renderText, EmailContent } from "../services/emailTemplates";
import { imageUrl } from "../utils/media";
import { publicAuction, minNextBid, isLive, hasEnded, productPath } from "../utils/serialize";

/** Bids in the last two minutes push the end back, so nobody can snipe at 0:01. */
const ANTI_SNIPE_MS = 2 * 60 * 1000;
const MAX_BID_GHS = 1_000_000;

const ghs = (n?: number | null) => `GH₵${(n ?? 0).toLocaleString("en-US")}`;
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const productLink = (m: IMerchProduct) => `${env.clientUrl}${productPath(m)}`;
const adminTab = (m: IMerchProduct) => (m.kind === "worn" ? "Worn on Set" : "Merch");
const windowHours = (m: IMerchProduct) => m.auction.payWindowHours || 48;
const deadline = (d: Date) =>
  d.toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Accra",
  });

/** "Kwame Mensah" → "Kwame M." — how bidders appear publicly. */
export function bidderName(name?: string | null): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Fan";
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}

async function email(to: string | null | undefined, c: EmailContent) {
  if (to) await sendMail(to, c.title, renderText(c), renderEmail(c)).catch(() => {});
}

function winEmail(m: IMerchProduct, amount: number | null | undefined, size: string | null | undefined, payBy: Date, secondChance = false) {
  return {
    title: secondChance ? `Second chance: ${m.name} is yours` : `You won ${m.name}!`,
    intro: secondChance
      ? `The winning bidder didn't pay in time, so it's offered to you for your bid of ${ghs(amount)}. Pay by ${deadline(payBy)} (Ghana time) to secure it.`
      : `Your bid of ${ghs(amount)} was the highest. Pay by ${deadline(payBy)} (Ghana time) to secure it — Mobile Money or card. We'll then contact you about delivery.`,
    pre: [`Item: ${m.name}`, size ? `Size: ${size}` : "", `Price: ${ghs(amount)}`, `Pay by: ${deadline(payBy)}`]
      .filter(Boolean)
      .join("\n"),
    button: { label: `Pay ${ghs(amount)}`, url: productLink(m) },
    note: "If you don't pay in time, the item goes to the next highest bidder.",
  } satisfies EmailContent;
}

/**
 * Announce an auction's result exactly once: email the winner (with their
 * payment deadline) and DMY, or tell DMY nobody bid. Claimed atomically so the
 * sweeper and a page load can't both send it.
 */
export async function closeAuction(m: IMerchProduct): Promise<void> {
  if (!hasEnded(m) || m.auction.closedAt) return;
  const now = new Date();
  const payBy = new Date(now.getTime() + windowHours(m) * 3600e3);
  const claimed = await MerchProduct.findOneAndUpdate(
    {
      _id: m._id,
      "auction.enabled": true,
      "auction.bidCount": { $gt: 0 }, // no bids → no clock → nothing to close
      "auction.endsAt": { $lte: now },
      "auction.closedAt": null,
    },
    { $set: { "auction.closedAt": now, ...(m.auction.highBidder ? { "auction.payBy": payBy } : {}) } },
    { new: true }
  );
  if (!claimed) return;
  const a = claimed.auction;
  if (!a.highBidder) {
    await MerchProduct.updateOne({ _id: claimed._id }, { $set: { "auction.unsold": true } });
    void sendNotification(
      `Auction ended with no bids — ${claimed.name}`,
      `Nobody bid on ${claimed.name}. Relist it from the admin ${adminTab(claimed)} tab (tick "Relist" — the 14-day clock starts again with the next first bid).`
    );
    return;
  }
  const winner = await User.findById(a.highBidder);
  void email(winner?.email, winEmail(claimed, a.highBidGhs, a.highSize, payBy));
  void sendNotification(
    `🔨 Auction won — ${claimed.name} · ${ghs(a.highBidGhs)}`,
    `Winner: ${winner?.name || a.highBidderName} (${winner?.email ?? "unknown"})` +
      (a.highSize ? `\nSize: ${a.highSize}` : "") +
      `\nBids: ${a.bidCount}\nPay by: ${deadline(payBy)}\n\nIf they don't pay in time it goes to the next highest bidder automatically. The paid order will show in the admin Orders tab.`
  );
}

/** The best remaining bidder (one per fan, their highest bid), skipping anyone excluded. */
async function nextBidder(productId: Types.ObjectId, exclude: Types.ObjectId[]) {
  const [next] = await MerchBid.aggregate<{ _id: Types.ObjectId; amount: number; size?: string; name: string }>([
    { $match: { product: productId, user: { $nin: exclude } } },
    { $sort: { amountGhs: -1, createdAt: 1 } },
    { $group: { _id: "$user", amount: { $first: "$amountGhs" }, size: { $first: "$size" }, name: { $first: "$name" } } },
    { $sort: { amount: -1 } },
    { $limit: 1 },
  ]);
  return next ?? null;
}

/**
 * The winner's payment window has passed: offer the item to the next highest
 * bidder (with a fresh window), or mark it unsold so DMY can relist it.
 */
export async function offerToNext(m: IMerchProduct): Promise<void> {
  const a = m.auction;
  const now = new Date();
  if (!a.highBidder || a.paidAt || !a.payBy || a.payBy > now) return;
  const lapsedUser = a.highBidder;
  const next = await nextBidder(m._id as Types.ObjectId, [...(a.lapsed ?? []), lapsedUser]);
  const payBy = new Date(now.getTime() + windowHours(m) * 3600e3);

  // Claim: only if nobody else already moved it on.
  const claimed = await MerchProduct.findOneAndUpdate(
    { _id: m._id, "auction.highBidder": lapsedUser, "auction.paidAt": null, "auction.payBy": { $lte: now } },
    next
      ? {
          $push: { "auction.lapsed": lapsedUser },
          $set: {
            "auction.highBidder": next._id,
            "auction.highBidGhs": next.amount,
            "auction.highBidderName": next.name,
            "auction.highSize": next.size ?? null,
            "auction.payBy": payBy,
          },
        }
      : {
          $push: { "auction.lapsed": lapsedUser },
          $set: { "auction.highBidder": null, "auction.payBy": null, "auction.unsold": true },
        },
    { new: true }
  );
  if (!claimed) return;

  const lapsed = await User.findById(lapsedUser);
  void email(lapsed?.email, {
    title: `Your payment window for ${m.name} has closed`,
    intro: `The ${windowHours(m)}-hour window to pay for your winning bid ran out, so the item has moved on. Thanks for bidding — there'll be more drops.`,
    button: { label: "See Worn on Set", url: `${env.clientUrl}/worn-on-set` },
  });
  if (next) {
    const nextUser = await User.findById(next._id);
    void email(nextUser?.email, winEmail(claimed, next.amount, next.size, payBy, true));
    void sendNotification(
      `↪️ ${m.name} offered to the next bidder — ${ghs(next.amount)}`,
      `${lapsed?.email ?? "The winner"} didn't pay in time. Now offered to ${nextUser?.name || next.name} (${nextUser?.email ?? "unknown"}) — pay by ${deadline(payBy)}.`
    );
  } else {
    void sendNotification(
      `⚠️ ${m.name} is unsold — relist it`,
      `The winner didn't pay and there are no other bidders left. Relist it from the admin ${adminTab(m)} tab (tick "Relist" — the 14-day clock starts again with the next first bid).`
    );
  }
}

/** Close ended auctions and move on unpaid winners. Runs on a timer (see index.ts). */
export async function sweepAuctions(): Promise<void> {
  const now = new Date();
  const due = await MerchProduct.find({
    "auction.enabled": true,
    "auction.bidCount": { $gt: 0 },
    "auction.endsAt": { $lte: now },
    "auction.closedAt": null,
  }).limit(50);
  for (const m of due) await closeAuction(m).catch((err) => console.error("[auction] close failed:", err));

  const overdue = await MerchProduct.find({
    "auction.enabled": true,
    "auction.closedAt": { $ne: null },
    "auction.paidAt": null,
    "auction.highBidder": { $ne: null },
    "auction.payBy": { $lte: now },
  }).limit(50);
  for (const m of overdue) await offerToNext(m).catch((err) => console.error("[auction] hand-over failed:", err));
}

async function findAuctionProduct(slug: string) {
  const m = await MerchProduct.findOne({ slug, hidden: { $ne: true } });
  if (!m || !m.auction?.enabled) throw httpError(404, "This item isn't up for auction");
  return m;
}

/** Everything the bidding panel needs; `you` is filled in for a signed-in fan. */
async function auctionView(m: IMerchProduct, userId?: string) {
  const bids = await MerchBid.find({ product: m._id }).sort({ createdAt: -1 }).limit(25);
  const a = m.auction;
  const isWinner = Boolean(userId && a.highBidder && String(a.highBidder) === userId);
  const myBest = userId
    ? (await MerchBid.findOne({ product: m._id, user: userId }).sort({ amountGhs: -1 }))?.amountGhs ?? null
    : null;
  const ended = hasEnded(m);
  const lapsed = Boolean(userId && (a.lapsed ?? []).some((u) => String(u) === userId));
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
          leading: isWinner && !ended,
          won: isWinner && ended,
          paid: isWinner && ended && Boolean(a.paidAt),
          lapsed,
          payBy: isWinner && ended ? a.payBy ?? null : null,
          myBestBidGhs: myBest,
          size: isWinner ? a.highSize ?? null : null,
        }
      : null,
  };
}

/** GET /api/merch/:slug/auction — live state + recent bids (optionally signed in). */
export async function getAuction(req: Request, res: Response, next: NextFunction) {
  try {
    let m = await findAuctionProduct(String(req.params.slug));
    // Keep the result current even if the timer hasn't run yet (e.g. after the server woke up).
    if (hasEnded(m) && !m.auction.closedAt) await closeAuction(m);
    else if (m.auction.payBy && m.auction.payBy <= new Date() && !m.auction.paidAt) await offerToNext(m);
    m = (await MerchProduct.findById(m._id)) ?? m;
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

    // Shop auctions ask for the bidder's size; a worn piece is one item in one size.
    let size: string | undefined;
    if (m.sizes.length && m.kind !== "worn") {
      size = String(req.body?.size || "");
      if (!m.sizes.includes(size)) throw httpError(400, "Choose your size");
    }

    const now = new Date();
    const name = bidderName(user.name);
    const previousLeader = m.auction.highBidder;
    const bidFields = {
      "auction.highBidGhs": amount,
      "auction.highBidder": user._id,
      "auction.highBidderName": name,
      "auction.highSize": size ?? null,
    };
    // Atomic: only wins if nobody has bid (or outbid this amount) since we read it.
    const updated = await MerchProduct.findOneAndUpdate(
      m.auction.bidCount > 0
        ? {
            _id: m._id,
            "auction.enabled": true,
            "auction.closedAt": null,
            "auction.endsAt": { $gt: now },
            "auction.highBidGhs": { $lte: amount - m.auction.minIncrementGhs },
          }
        : // The first bid: it starts the clock.
          {
            _id: m._id,
            "auction.enabled": true,
            "auction.closedAt": null,
            "auction.bidCount": { $in: [0, null] },
            "auction.startingBidGhs": { $lte: amount },
          },
      {
        $set:
          m.auction.bidCount > 0
            ? bidFields
            : { ...bidFields, "auction.endsAt": new Date(now.getTime() + AUCTION_RUN_DAYS * 86400e3) },
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
    if ((a.lapsed ?? []).some((u) => String(u) === String(user._id))) {
      throw httpError(410, "Your payment window closed, so the item went to the next bidder");
    }
    if (!a.highBidder || String(a.highBidder) !== String(user._id) || a.highBidGhs == null) {
      throw httpError(403, "Only the winning bidder can pay for this item");
    }
    if (a.paidAt) throw httpError(409, "You've already paid for this item");
    if (a.payBy && a.payBy <= new Date()) throw httpError(410, "Your payment window has closed");
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
          name: `${m.name} (${m.kind === "worn" ? "Worn on Set auction" : "auction win"})`,
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

/**
 * Called once an auction order is paid (from checkout fulfilment). If the
 * payer is no longer the winner (their window closed while they were paying),
 * DMY is told so they can refund — the item isn't marked sold to them.
 */
export async function markAuctionPaid(productId: string, payerEmail?: string): Promise<boolean> {
  if (!Types.ObjectId.isValid(productId)) return false;
  const m = await MerchProduct.findById(productId);
  if (!m) return false;
  const winner = m.auction.highBidder ? await User.findById(m.auction.highBidder) : null;
  const payerIsWinner = Boolean(winner && payerEmail && winner.email.toLowerCase() === payerEmail.toLowerCase());
  if (!payerIsWinner || m.auction.paidAt) {
    void sendNotification(
      `⚠️ Late auction payment — ${m.name}`,
      `${payerEmail ?? "Someone"} paid after their payment window closed` +
        (winner ? `; the item is now with ${winner.email}` : m.auction.paidAt ? "; it was already paid for" : "") +
        `. Refund ${payerEmail ?? "them"} (or sort it out with them) — the order is in the admin Orders tab.`
    );
    return false;
  }
  await MerchProduct.updateOne({ _id: productId, "auction.paidAt": null }, { $set: { "auction.paidAt": new Date() } });
  return true;
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
        if (!m || !m.auction?.enabled) return null;
        const a = m.auction;
        const winner = Boolean(a.highBidder && String(a.highBidder) === userId);
        const lapsed = (a.lapsed ?? []).some((u) => String(u) === userId);
        const ended = hasEnded(m);
        const status = !ended
          ? winner
            ? "leading"
            : "outbid"
          : lapsed
          ? "lapsed"
          : winner
          ? a.paidAt
            ? "paid"
            : "won"
          : "lost";
        return {
          slug: m.slug,
          path: productPath(m),
          name: m.name,
          image: imageUrl(m.images?.[0]) ?? null,
          myBestBidGhs: b.best,
          highBidGhs: a.highBidGhs ?? null,
          endsAt: a.endsAt,
          payBy: winner && ended ? a.payBy ?? null : null,
          status,
        };
      })
      .filter(Boolean);
    res.json(out);
  } catch (err) {
    next(err);
  }
}
