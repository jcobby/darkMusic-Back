import { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import { User } from "../models/User";
import { Order } from "../models/Order";
import { Donation } from "../models/Donation";
import { StreamPass } from "../models/StreamPass";
import { LiveTicket } from "../models/LiveEvent";
import { GameScore } from "../models/GameScore";
import { MerchBid } from "../models/MerchBid";
import { ModelBooking } from "../models/ModelBooking";
import { FanPost } from "../models/FanPost";
import { Favorite } from "../models/Favorite";
import { Vote } from "../models/Vote";
import { Rating } from "../models/Rating";
import { WalletTxn } from "../models/Wallet";
import { Feedback } from "../models/Feedback";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86400000;
const PAGE_SIZE = 50;
const SORTS = ["newest", "active", "spent", "games", "points"] as const;
type Sort = (typeof SORTS)[number];

type Agg = { _id: unknown; n: number; ghs?: number; runs?: number; best?: number };
const byKey = (rows: Agg[]) => new Map(rows.map((r) => [String(r._id), r]));

/**
 * GET /api/admin/customers?q=&sort=newest|active|spent|games|points&page=1
 * Every account with what they've done on the site: when they joined and were last
 * on, money spent (shop, tips, passes, tickets, bookings), games played, bids, posts…
 */
export async function adminListCustomers(req: Request, res: Response, next: NextFunction) {
  try {
    const q = String(req.query.q || "").trim().slice(0, 80);
    const sort: Sort = SORTS.includes(req.query.sort as Sort) ? (req.query.sort as Sort) : "newest";
    const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
    const rx = q ? new RegExp(escapeRx(q), "i") : null;
    const users = await User.find(rx ? { $or: [{ name: rx }, { email: rx }, { phone: rx }] } : {})
      .select("name email phone emailVerified points streak lastCheckIn createdAt lastSeenAt referredBy")
      .lean();
    const ids = users.map((u) => u._id);
    const idStrs = ids.map(String);
    const emails = users.map((u) => u.email);

    const [orders, donations, passes, tickets, games, bids, bookings, posts, feedback] = await Promise.all([
      Order.aggregate<Agg>([
        { $match: { status: "paid" } },
        { $group: { _id: { $toLower: "$customerEmail" }, n: { $sum: 1 }, ghs: { $sum: "$totalGhs" } } },
        { $match: { _id: { $in: emails } } },
      ]),
      Donation.aggregate<Agg>([
        { $match: { status: "paid", email: { $in: emails } } },
        { $group: { _id: "$email", n: { $sum: 1 }, ghs: { $sum: "$amountGhs" } } },
      ]),
      StreamPass.aggregate<Agg>([
        { $match: { status: "paid", user: { $in: idStrs } } },
        { $group: { _id: "$user", n: { $sum: 1 }, ghs: { $sum: "$amountGhs" } } },
      ]),
      LiveTicket.aggregate<Agg>([
        { $match: { status: "paid", user: { $in: ids } } },
        { $group: { _id: "$user", n: { $sum: 1 }, ghs: { $sum: "$amountGhs" } } },
      ]),
      GameScore.aggregate<Agg>([
        { $match: { user: { $in: ids } } },
        // A month's score is a total of days from November 2026 — its best game is bestRun.
        { $group: { _id: "$user", n: { $sum: 1 }, runs: { $sum: "$runs" }, best: { $max: { $ifNull: ["$bestRun", "$score"] } } } },
      ]),
      MerchBid.aggregate<Agg>([{ $match: { user: { $in: ids } } }, { $group: { _id: "$user", n: { $sum: 1 } } }]),
      ModelBooking.aggregate<Agg>([
        { $match: { customer: { $in: ids } } },
        {
          $group: {
            _id: "$customer",
            n: { $sum: 1 },
            ghs: { $sum: { $cond: [{ $ifNull: ["$paidAt", false] }, { $ifNull: ["$priceGhs", 0] }, 0] } },
          },
        },
      ]),
      FanPost.aggregate<Agg>([{ $match: { user: { $in: idStrs } } }, { $group: { _id: "$user", n: { $sum: 1 } } }]),
      Feedback.aggregate<Agg>([{ $match: { user: { $in: ids } } }, { $group: { _id: "$user", n: { $sum: 1 } } }]),
    ]);
    const m = {
      orders: byKey(orders),
      donations: byKey(donations),
      passes: byKey(passes),
      tickets: byKey(tickets),
      games: byKey(games),
      bids: byKey(bids),
      bookings: byKey(bookings),
      posts: byKey(posts),
      feedback: byKey(feedback),
    };

    const rows = users.map((u) => {
      const id = String(u._id);
      const paid = [m.orders.get(u.email), m.donations.get(u.email), m.passes.get(id), m.tickets.get(id), m.bookings.get(id)];
      return {
        id,
        name: u.name ?? null,
        email: u.email,
        phone: u.phone ?? null,
        emailVerified: Boolean(u.emailVerified),
        joinedAt: u.createdAt,
        lastSeenAt: u.lastSeenAt ?? null,
        lastCheckIn: u.lastCheckIn ?? null,
        points: u.points ?? 0,
        streak: u.streak ?? 0,
        referred: Boolean(u.referredBy),
        spentGhs: round2(paid.reduce((s, a) => s + (a?.ghs ?? 0), 0)),
        purchases: (m.orders.get(u.email)?.n ?? 0) + (m.passes.get(id)?.n ?? 0) + (m.tickets.get(id)?.n ?? 0),
        tips: m.donations.get(u.email)?.n ?? 0,
        games: m.games.get(id)?.runs ?? 0,
        bestScore: m.games.get(id)?.best ?? 0,
        bids: m.bids.get(id)?.n ?? 0,
        bookings: m.bookings.get(id)?.n ?? 0,
        posts: m.posts.get(id)?.n ?? 0,
        feedback: m.feedback.get(id)?.n ?? 0,
      };
    });

    const time = (d: Date | string | null) => (d ? new Date(d).getTime() : 0);
    const order: Record<Sort, (a: (typeof rows)[number], b: (typeof rows)[number]) => number> = {
      newest: (a, b) => time(b.joinedAt) - time(a.joinedAt),
      active: (a, b) => time(b.lastSeenAt) - time(a.lastSeenAt) || time(b.joinedAt) - time(a.joinedAt),
      spent: (a, b) => b.spentGhs - a.spentGhs || time(b.joinedAt) - time(a.joinedAt),
      games: (a, b) => b.games - a.games || b.bestScore - a.bestScore,
      points: (a, b) => b.points - a.points || time(b.joinedAt) - time(a.joinedAt),
    };
    rows.sort(order[sort]);

    const now = Date.now();
    res.json({
      summary: {
        accounts: rows.length,
        confirmed: rows.filter((r) => r.emailVerified).length,
        joinedThisWeek: rows.filter((r) => now - time(r.joinedAt) < 7 * DAY).length,
        activeThisWeek: rows.filter((r) => now - time(r.lastSeenAt) < 7 * DAY).length,
        paying: rows.filter((r) => r.spentGhs > 0).length,
        players: rows.filter((r) => r.games > 0).length,
        spentGhs: round2(rows.reduce((s, r) => s + r.spentGhs, 0)),
      },
      q,
      sort,
      page,
      pageSize: PAGE_SIZE,
      total: rows.length,
      customers: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    });
  } catch (err) {
    next(err);
  }
}

interface Event {
  at: Date;
  kind: "joined" | "purchase" | "tip" | "pass" | "ticket" | "bid" | "booking" | "game" | "prize" | "withdrawal" | "post" | "feedback";
  text: string;
  amountGhs?: number;
}

/** GET /api/admin/customers/:id — one customer's profile and everything they've done, newest first. */
export async function adminCustomerDetail(req: Request, res: Response, next: NextFunction) {
  try {
    if (!Types.ObjectId.isValid(String(req.params.id))) throw httpError(400, "Invalid id");
    const u = await User.findById(req.params.id).lean();
    if (!u) throw httpError(404, "Customer not found");
    const id = String(u._id);
    const email = u.email;
    const emailRx = new RegExp(`^${escapeRx(email)}$`, "i");

    const [orders, donations, passes, tickets, games, bids, bookings, wallet, posts, feedback, favorites, votes, ratings] =
      await Promise.all([
        Order.find({ customerEmail: emailRx, status: "paid" }).sort({ createdAt: -1 }).limit(50).lean(),
        Donation.find({ email, status: "paid" }).sort({ createdAt: -1 }).limit(50).lean(),
        StreamPass.find({ user: id, status: "paid" }).sort({ createdAt: -1 }).limit(50).lean(),
        LiveTicket.find({ user: u._id, status: "paid" }).sort({ createdAt: -1 }).limit(50).populate<{ event: { title: string } | null }>("event", "title").lean(),
        GameScore.find({ user: u._id }).sort({ month: -1 }).limit(24).lean(),
        MerchBid.find({ user: u._id }).sort({ createdAt: -1 }).limit(50).populate<{ product: { name: string } | null }>("product", "name").lean(),
        ModelBooking.find({ customer: u._id }).sort({ createdAt: -1 }).limit(50).lean(),
        WalletTxn.find({ user: u._id }).sort({ createdAt: -1 }).limit(50).lean(),
        FanPost.find({ user: id }).sort({ createdAt: -1 }).limit(30).lean(),
        Feedback.find({ user: u._id }).sort({ createdAt: -1 }).limit(30).lean(),
        Favorite.countDocuments({ user: id }),
        Vote.countDocuments({ user: id }),
        Rating.countDocuments({ user: id }),
      ]);

    const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const monthName = (m: string) =>
      new Date(`${m}-01T00:00:00Z`).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    const events: Event[] = [
      { at: u.createdAt, kind: "joined" as const, text: `Created an account${u.referredBy ? " (invited by a friend's referral code)" : ""}` },
      ...orders.map((o) => ({
        at: o.createdAt,
        kind: "purchase" as const,
        text: `Bought ${o.items.map((i) => `${i.name}${i.size ? ` (${i.size})` : ""}${i.qty > 1 ? ` ×${i.qty}` : ""}`).join(", ")}`,
        amountGhs: o.totalGhs,
      })),
      ...donations.map((d) => ({ at: d.createdAt, kind: "tip" as const, text: `Supported DMY${d.message ? ` — “${clip(d.message)}”` : ""}`, amountGhs: d.amountGhs })),
      ...passes.map((p) => ({ at: p.createdAt, kind: "pass" as const, text: "Bought a streaming pass", amountGhs: p.amountGhs })),
      ...tickets.map((t) => ({ at: t.paidAt ?? t.createdAt, kind: "ticket" as const, text: `Ticket for ${t.event?.title ?? "a live show"}`, amountGhs: t.amountGhs })),
      ...bids.map((b) => ({ at: b.createdAt, kind: "bid" as const, text: `Bid on ${b.product?.name ?? "a Worn on Set piece"}`, amountGhs: b.amountGhs })),
      ...bookings.map((b) => ({
        at: b.createdAt,
        kind: "booking" as const,
        text: `Booked ${b.modelName}${b.date ? ` for ${b.date}` : ""} — ${b.status}`,
        amountGhs: b.paidAt ? b.priceGhs : undefined,
      })),
      ...games.map((g) => ({
        at: g.achievedAt,
        kind: "game" as const,
        text:
          `Beat Breaker, ${monthName(g.month)}: ${g.runs} game${g.runs === 1 ? "" : "s"}, ` +
          (g.bestRun != null
            ? `${g.days ?? 0} day${g.days === 1 ? "" : "s"}, ${g.score.toLocaleString()} pts, best game ${g.bestRun.toLocaleString()} (level ${g.level})`
            : `best ${g.score.toLocaleString()} (level ${g.level})`) +
          (g.disqualified ? " — disqualified" : ""),
      })),
      ...wallet.map((w) => ({
        at: w.createdAt,
        kind: w.kind === "prize" ? ("prize" as const) : ("withdrawal" as const),
        text: w.kind === "prize" ? `Won the ${w.month ? monthName(w.month) : ""} game prize (${w.status})` : `Asked to withdraw to Mobile Money (${w.status})`,
        amountGhs: w.amountGhs,
      })),
      ...posts.map((p) => ({ at: p.createdAt, kind: "post" as const, text: `Posted on Lenko Army: “${clip(p.body || "(photo)")}”` })),
      ...feedback.map((f) => ({
        at: f.createdAt,
        kind: "feedback" as const,
        text: `Feedback${f.rating ? ` (${f.rating}★)` : ""} on ${f.page}: “${clip(f.message)}”`,
      })),
    ].filter((e) => e.at);
    events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    res.json({
      id,
      name: u.name ?? null,
      email,
      phone: u.phone ?? null,
      emailVerified: Boolean(u.emailVerified),
      joinedAt: u.createdAt,
      lastSeenAt: u.lastSeenAt ?? null,
      points: u.points ?? 0,
      streak: u.streak ?? 0,
      lastCheckIn: u.lastCheckIn ?? null,
      referralCode: u.referralCode,
      streamUntil: u.streamUntil ?? null,
      counts: { favorites, votes, ratings },
      spentGhs: round2(events.filter((e) => ["purchase", "tip", "pass", "ticket", "booking"].includes(e.kind)).reduce((s, e) => s + (e.amountGhs ?? 0), 0)),
      events: events.slice(0, 200),
    });
  } catch (err) {
    next(err);
  }
}
