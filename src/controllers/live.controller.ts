import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { Types } from "mongoose";
import { env } from "../config/env";
import { LiveEvent, ILiveEvent, LiveTicket, ILiveTicket } from "../models/LiveEvent";
import { User } from "../models/User";
import { initializeTransaction, verifyTransaction } from "../services/paystack";
import { sendMail, sendNotification } from "../services/mailer";
import { renderEmail, renderText, EmailContent } from "../services/emailTemplates";
import { uploadBuffer } from "../services/cloudinary";
import { UploadedFiles } from "../services/upload";
import { imageUrl } from "../utils/media";
import { slugify } from "../utils/slug";

const ghs = (n?: number) => `GH₵${(n ?? 0).toLocaleString("en-US")}`;
const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const VISIBLE = { hidden: { $ne: true } };
const eventLink = (e: ILiveEvent) => `${env.clientUrl}/live/${e.slug}`;

async function email(to: string | null | undefined, c: EmailContent) {
  if (to) await sendMail(to, c.title, renderText(c), renderEmail(c)).catch(() => {});
}

type LiveStatus = "upcoming" | "live" | "ended";
export function liveStatus(e: ILiveEvent, now = Date.now()): LiveStatus {
  const start = e.startsAt.getTime();
  if (now < start) return "upcoming";
  if (now < start + (e.durationMins || 120) * 60000) return "live";
  return "ended";
}

/** Public shape — never includes the stream link. */
function publicEvent(e: ILiveEvent, ticket?: ILiveTicket | null) {
  const status = liveStatus(e);
  const hasTicket = ticket?.status === "paid";
  return {
    id: String(e._id),
    title: e.title,
    slug: e.slug,
    description: e.description || null,
    poster: imageUrl(e.poster) ?? null,
    startsAt: e.startsAt,
    durationMins: e.durationMins,
    priceGhs: e.priceGhs,
    replay: e.replay,
    status,
    onSale: status !== "ended" || e.replay,
    hasTicket,
    // Ticket holders can watch while it's live, and afterwards when there's a replay.
    canWatch: hasTicket && Boolean(e.streamUrl) && (status !== "ended" || e.replay),
  };
}

async function ticketsFor(userId: string | undefined, eventIds: unknown[]) {
  if (!userId) return new Map<string, ILiveTicket>();
  const tickets = await LiveTicket.find({ user: userId, event: { $in: eventIds } });
  return new Map(tickets.map((t) => [String(t.event), t]));
}

/** GET /api/live — upcoming and live shows first, then past ones with replays. */
export async function listLive(req: Request, res: Response, next: NextFunction) {
  try {
    const events = await LiveEvent.find(VISIBLE).sort({ startsAt: 1 }).limit(100);
    const tickets = await ticketsFor(req.fan?.id, events.map((e) => e._id));
    const out = events.map((e) => publicEvent(e, tickets.get(String(e._id))));
    const order: Record<LiveStatus, number> = { live: 0, upcoming: 1, ended: 2 };
    out.sort((a, b) =>
      order[a.status] - order[b.status] ||
      (a.status === "ended"
        ? new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime()
        : new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
    );
    res.json(out);
  } catch (err) {
    next(err);
  }
}

async function findEvent(slug: string) {
  const e = await LiveEvent.findOne({ slug, ...VISIBLE });
  if (!e) throw httpError(404, "Show not found");
  return e;
}

/** GET /api/live/:slug */
export async function getLive(req: Request, res: Response, next: NextFunction) {
  try {
    const e = await findEvent(String(req.params.slug));
    const ticket = req.fan?.id ? await LiveTicket.findOne({ event: e._id, user: req.fan.id }) : null;
    res.json(publicEvent(e, ticket));
  } catch (err) {
    next(err);
  }
}

/** POST /api/live/:slug/ticket — a signed-in fan starts paying for a ticket. */
export async function buyTicket(req: Request, res: Response, next: NextFunction) {
  try {
    const e = await findEvent(String(req.params.slug));
    const user = await User.findById(req.fan?.id);
    if (!user) throw httpError(404, "Account not found");
    if (!publicEvent(e).onSale) throw httpError(409, "Tickets for this show are no longer on sale");
    const existing = await LiveTicket.findOne({ event: e._id, user: user._id });
    if (existing?.status === "paid") throw httpError(409, "You already have a ticket for this show");

    const reference = `DMY-LIVE-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    await LiveTicket.updateOne(
      { event: e._id, user: user._id },
      {
        $setOnInsert: { email: user.email, status: "pending" },
        $set: { amountGhs: e.priceGhs },
        $push: { paymentRefs: reference },
      },
      { upsert: true }
    );
    const init = await initializeTransaction({
      email: user.email,
      amountGhs: e.priceGhs,
      reference,
      callbackUrl: `${env.clientUrl}/live/${e.slug}?ticket=1`,
      metadata: { type: "live_ticket", reference, eventId: String(e._id) },
    });
    res.json({ authorizationUrl: init.authorizationUrl, reference, amountGhs: e.priceGhs });
  } catch (err) {
    next(err);
  }
}

/**
 * Mark a ticket paid exactly once (verify-on-return and the webhook may both
 * call this). Returns null when the reference isn't a live ticket.
 */
export async function markTicketPaid(
  reference: string,
  paystackRef?: string,
  amountGhs?: number
): Promise<ILiveTicket | null> {
  const existing = await LiveTicket.findOne({ paymentRefs: reference });
  if (!existing) return null;
  if (amountGhs !== undefined && amountGhs < existing.amountGhs) {
    void sendNotification(
      `⚠️ Live ticket underpaid — ${reference}`,
      `Paid ${ghs(amountGhs)} but the ticket costs ${ghs(existing.amountGhs)}. Check it in Paystack.`
    );
    return existing;
  }
  const claimed = await LiveTicket.findOneAndUpdate(
    { _id: existing._id, status: { $ne: "paid" } },
    { $set: { status: "paid", paidAt: new Date(), paystackRef: paystackRef || reference } },
    { new: true }
  );
  if (!claimed) return LiveTicket.findById(existing._id);

  const e = await LiveEvent.findById(claimed.event);
  if (e) {
    const when = e.startsAt.toLocaleString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Africa/Accra",
    });
    void email(claimed.email, {
      title: `Your ticket: ${e.title}`,
      intro: `You're in. The show starts ${when} (Ghana time). Open the show page while signed in to watch${
        e.replay ? " — and catch the replay afterwards" : ""
      }.`,
      button: { label: "Go to the show", url: eventLink(e) },
      note: "Your ticket is linked to your Dark Music Yard account — sign in on any device to watch.",
    });
    void sendNotification(`🎟️ Live ticket sold — ${e.title} · ${ghs(claimed.amountGhs)}`, `Buyer: ${claimed.email}`);
  }
  return claimed;
}

/** GET /api/live/:slug/ticket/verify?reference= — confirm payment on return from Paystack. */
export async function verifyTicket(req: Request, res: Response, next: NextFunction) {
  try {
    const e = await findEvent(String(req.params.slug));
    const reference = String(req.query.reference || "");
    let ticket: ILiveTicket | null = await LiveTicket.findOne({ event: e._id, user: req.fan?.id, paymentRefs: reference });
    if (!ticket) throw httpError(404, "Ticket not found");
    if (ticket.status !== "paid") {
      const result = await verifyTransaction(reference);
      if (result.paid) ticket = (await markTicketPaid(reference, result.reference, result.amountGhs)) ?? ticket;
    }
    res.json(publicEvent(e, ticket));
  } catch (err) {
    next(err);
  }
}

/** GET /api/live/:slug/watch — the stream link, for ticket holders only. */
export async function watchLive(req: Request, res: Response, next: NextFunction) {
  try {
    const e = await findEvent(String(req.params.slug));
    const ticket = await LiveTicket.findOne({ event: e._id, user: req.fan?.id, status: "paid" });
    if (!ticket) throw httpError(403, "Buy a ticket to watch this show");
    const view = publicEvent(e, ticket);
    if (!e.streamUrl) throw httpError(404, "The stream will appear here when the show starts");
    if (!view.canWatch) throw httpError(410, "This show has ended and has no replay");
    res.json({ streamUrl: e.streamUrl, status: view.status });
  } catch (err) {
    next(err);
  }
}

// ---------- Admin ----------
const asBool = (v: unknown) => v === true || v === "true" || v === "on" || v === "1";

async function uniqueSlug(base: string, currentId?: string) {
  const root = slugify(base) || "show";
  let slug = root;
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await LiveEvent.exists({ slug, ...(currentId ? { _id: { $ne: currentId } } : {}) })) slug = `${root}-${++n}`;
  return slug;
}

async function posterUpload(req: Request): Promise<string | undefined> {
  const f = (req.files as UploadedFiles | undefined)?.poster?.[0];
  return f ? (await uploadBuffer(f.buffer, "image")).url : undefined;
}

function readFields(b: Record<string, unknown>, e?: ILiveEvent) {
  const out: Partial<ILiveEvent> = {};
  if (b.title !== undefined) out.title = String(b.title).trim();
  if (b.description !== undefined) out.description = String(b.description);
  if (b.startsAt !== undefined) {
    const d = new Date(String(b.startsAt));
    if (isNaN(d.getTime())) throw httpError(400, "Set when the show starts");
    out.startsAt = d;
  }
  if (b.durationMins !== undefined) out.durationMins = Math.max(15, Math.round(Number(b.durationMins) || e?.durationMins || 120));
  if (b.priceGhs !== undefined) {
    const p = Math.round(Number(b.priceGhs));
    if (!Number.isFinite(p) || p < 1) throw httpError(400, "The ticket price must be at least GH₵1");
    out.priceGhs = p;
  }
  if (b.streamUrl !== undefined) out.streamUrl = String(b.streamUrl).trim();
  if (b.replay !== undefined) out.replay = asBool(b.replay);
  if (b.hidden !== undefined) out.hidden = asBool(b.hidden);
  return out;
}

async function adminRow(e: ILiveEvent) {
  const [sold] = await LiveTicket.aggregate<{ count: number; total: number }>([
    { $match: { event: new Types.ObjectId(String(e._id)), status: "paid" } },
    { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$amountGhs" } } },
  ]);
  return { ...e.toObject(), status: liveStatus(e), ticketsSold: sold?.count ?? 0, ticketRevenueGhs: sold?.total ?? 0 };
}

export async function adminListLive(_req: Request, res: Response, next: NextFunction) {
  try {
    const events = await LiveEvent.find().sort({ startsAt: -1 });
    res.json(await Promise.all(events.map(adminRow)));
  } catch (err) {
    next(err);
  }
}

export async function createLive(req: Request, res: Response, next: NextFunction) {
  try {
    const b = req.body ?? {};
    const fields = readFields(b);
    if (!fields.title) throw httpError(400, "Title is required");
    if (!fields.startsAt) throw httpError(400, "Set when the show starts");
    if (!fields.priceGhs) throw httpError(400, "Set a ticket price");
    const e = await LiveEvent.create({
      ...fields,
      slug: await uniqueSlug(String(b.slug || fields.title)),
      poster: await posterUpload(req),
    });
    res.status(201).json(await adminRow(e));
  } catch (err) {
    next(err);
  }
}

export async function updateLive(req: Request, res: Response, next: NextFunction) {
  try {
    const e = await LiveEvent.findById(req.params.id);
    if (!e) throw httpError(404, "Show not found");
    const b = req.body ?? {};
    e.set(readFields(b, e));
    if (b.slug) e.slug = await uniqueSlug(String(b.slug), String(e._id));
    const poster = await posterUpload(req);
    if (poster) e.poster = poster;
    await e.save();
    res.json(await adminRow(e));
  } catch (err) {
    next(err);
  }
}

export async function deleteLive(req: Request, res: Response, next: NextFunction) {
  try {
    const e = await LiveEvent.findById(req.params.id);
    if (!e) throw httpError(404, "Show not found");
    const sold = await LiveTicket.countDocuments({ event: e._id, status: "paid" });
    if (sold > 0) throw httpError(409, `${sold} ticket(s) sold — hide the show instead of deleting it`);
    await LiveTicket.deleteMany({ event: e._id });
    await e.deleteOne();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
