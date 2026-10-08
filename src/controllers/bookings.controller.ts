import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { Types } from "mongoose";
import { env } from "../config/env";
import { MODELS_MARKET, splitPrice } from "../config/modelsMarket";
import { ModelBooking, IModelBooking, BookingStatus } from "../models/ModelBooking";
import { ModelProfile, IModelProfile } from "../models/ModelProfile";
import { User } from "../models/User";
import { initializeTransaction, verifyTransaction } from "../services/paystack";
import { sendMail, sendNotification } from "../services/mailer";
import { renderEmail, renderText, EmailContent } from "../services/emailTemplates";
import { imageUrl } from "../utils/media";
import { privateModel } from "../utils/serialize";
import { readModelFields, SELF_EDITABLE, ModelFieldKey } from "../utils/modelFields";

// Public models exclude hidden items and anything awaiting review / rejected.
export const VISIBLE_MODEL = { hidden: { $ne: true }, status: { $nin: ["pending", "rejected"] } };

// Contact details are only exchanged once the customer has paid through DMY.
const CONTACT_OPEN = new Set<BookingStatus>(["paid", "completed"]);
const LEGACY = ["new", "read", "archived"];

const ghs = (n?: number) => `GH₵${(n ?? 0).toLocaleString("en-US")}`;
const today = () => new Date().toISOString().slice(0, 10);
const firstName = (name?: string) => (name || "").trim().split(/\s+/)[0] || "Customer";
const str = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.trim().slice(0, max);
  return s || undefined;
};
const httpError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
const accountLink = () => `${env.clientUrl}/account`;

async function email(to: string | null | undefined, c: EmailContent) {
  if (to) await sendMail(to, c.title, renderText(c), renderEmail(c));
}

/** Where to reach a model: their profile contact, else their account's. */
async function modelContact(m: IModelProfile) {
  const user = m.submittedBy ? await User.findById(m.submittedBy) : null;
  return { email: m.email || user?.email || null, phone: m.phone || user?.phone || null };
}

function detailsText(b: IModelBooking): string {
  return [
    `Model: ${b.modelName}`,
    b.date ? `Date: ${b.date}${b.time ? ` at ${b.time}` : ""}` : "",
    b.location ? `Location: ${b.location}` : "",
    b.eventType ? `Shoot type: ${b.eventType}` : "",
    b.durationHours ? `Duration: ${b.durationHours} hour${b.durationHours === 1 ? "" : "s"}` : "",
    b.modelsCount && b.modelsCount > 1 ? `Models needed in total: ${b.modelsCount}` : "",
    b.offerGhs ? `Customer's offer: ${ghs(b.offerGhs)}` : "",
    b.priceGhs ? `Agreed price: ${ghs(b.priceGhs)}` : "",
    b.message ? `Requirements: ${b.message}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function bookingDetails(b: IModelBooking) {
  return {
    id: String(b._id),
    status: b.status,
    date: b.date || null,
    time: b.time || null,
    location: b.location || null,
    shootType: b.eventType || null,
    durationHours: b.durationHours ?? null,
    modelsCount: b.modelsCount ?? 1,
    requirements: b.message || null,
    offerGhs: b.offerGhs ?? null,
    priceGhs: b.priceGhs ?? null,
    declineReason: b.declineReason || null,
    cancelledBy: b.cancelledBy || null,
    review: b.review ? { stars: b.review.stars, comment: b.review.comment || null } : null,
    createdAt: b.createdAt,
  };
}

/** Customer's view — the model's contact details unlock once they've paid. */
function forCustomer(
  b: IModelBooking,
  m: IModelProfile | null | undefined,
  contact: { email: string | null; phone: string | null } | null
) {
  return {
    ...bookingDetails(b),
    model: {
      name: b.modelName,
      slug: m?.slug ?? null,
      photo: imageUrl(m?.photos?.[0]) ?? null,
    },
    contact: CONTACT_OPEN.has(b.status) ? contact : null,
  };
}

/** Model's view — the customer's contact details unlock once they've paid. */
function forModel(b: IModelBooking) {
  const open = CONTACT_OPEN.has(b.status);
  return {
    ...bookingDetails(b),
    customerName: open ? b.clientName : firstName(b.clientName),
    customer: open ? { name: b.clientName, email: b.email, phone: b.phone || null } : null,
    commissionGhs: b.commissionGhs ?? null,
    payoutGhs: b.payoutGhs ?? null,
    payoutStatus: b.payoutStatus,
  };
}

/** Atomically move a booking between states, so racing actions can't both win. */
async function transition(
  b: IModelBooking,
  from: BookingStatus[],
  set: Record<string, unknown>,
  failMessage: string
): Promise<IModelBooking> {
  const updated = await ModelBooking.findOneAndUpdate(
    { _id: b._id, status: { $in: from } },
    { $set: set },
    { new: true }
  );
  if (!updated) throw httpError(409, failMessage);
  return updated;
}

/**
 * Apply a model's or DMY's action to a booking and send the matching emails.
 * Models can accept / decline / complete; DMY can also cancel, record the
 * payout, and tidy legacy enquiries.
 */
export async function applyBookingAction(
  b: IModelBooking,
  action: string,
  body: Record<string, unknown>,
  actor: "model" | "admin"
): Promise<IModelBooking> {
  const now = new Date();
  switch (action) {
    case "accept": {
      const price = Math.round(Number(body.priceGhs ?? b.offerGhs));
      if (!Number.isFinite(price) || price < MODELS_MARKET.minRateGhs) {
        throw httpError(400, `The price must be at least ${ghs(MODELS_MARKET.minRateGhs)}`);
      }
      const updated = await transition(
        b,
        ["requested"],
        { status: "accepted", priceGhs: price, ...splitPrice(price), respondedAt: now },
        "Only new requests can be accepted"
      );
      void email(updated.email, {
        title: `${updated.modelName} accepted your booking`,
        intro: `Pay ${ghs(price)} to confirm it. ${updated.modelName}'s contact details are shared with you as soon as the payment goes through.`,
        pre: detailsText(updated),
        button: { label: `Pay ${ghs(price)}`, url: accountLink() },
        note: "Changed your mind? You can cancel from your account before paying.",
      });
      return updated;
    }

    case "decline": {
      const reason = str(body.reason, 300);
      const updated = await transition(
        b,
        ["requested", "accepted"],
        { status: "declined", declineReason: reason, respondedAt: now },
        "Paid bookings can't be declined — contact DMY"
      );
      void email(updated.email, {
        title: `${updated.modelName} can't take this booking`,
        intro: reason
          ? `Their note: “${reason}”`
          : "They're not available for this one — there are other models on Dark Music Yard.",
        pre: detailsText(updated),
        button: { label: "Browse models", url: `${env.clientUrl}/models` },
      });
      return updated;
    }

    case "complete": {
      if (actor === "model" && b.date && b.date > today()) {
        throw httpError(400, "You can mark it completed on or after the shoot date");
      }
      const updated = await transition(
        b,
        ["paid"],
        { status: "completed", completedAt: now },
        "Only paid bookings can be marked completed"
      );
      void email(updated.email, {
        title: `How was your shoot with ${updated.modelName}?`,
        intro: "Leave a quick rating — it helps other customers and the model.",
        button: { label: "Leave a review", url: accountLink() },
      });
      void sendNotification(
        `Payout due — ${updated.modelName} · ${ghs(updated.payoutGhs)}`,
        `The booking with ${updated.clientName} is completed. Pay the model ${ghs(updated.payoutGhs)}, then mark the payout as sent in the admin Bookings tab.\n\n${detailsText(updated)}`
      );
      return updated;
    }

    case "cancel": {
      if (actor !== "admin") break;
      const wasPaid = b.status === "paid";
      const updated = await transition(
        b,
        ["requested", "accepted", "paid"],
        { status: "cancelled", cancelledAt: now, cancelledBy: "admin" },
        "This booking can't be cancelled"
      );
      void email(updated.email, {
        title: `Your booking with ${updated.modelName} was cancelled`,
        intro: wasPaid
          ? "Dark Music Yard cancelled this booking. We'll contact you about your refund."
          : "Dark Music Yard cancelled this booking.",
        pre: detailsText(updated),
      });
      const m = await ModelProfile.findById(updated.modelId);
      if (m) {
        void email((await modelContact(m)).email, {
          title: `Booking cancelled — ${updated.date ?? ""} ${updated.time ?? ""}`.trim(),
          intro: "Dark Music Yard cancelled this booking.",
          pre: detailsText(updated),
        });
      }
      return updated;
    }

    case "payout": {
      if (actor !== "admin") break;
      const updated = await ModelBooking.findOneAndUpdate(
        { _id: b._id, status: "completed", payoutStatus: "unpaid" },
        { $set: { payoutStatus: "paid", payoutAt: now, payoutNote: str(body.note, 300) } },
        { new: true }
      );
      if (!updated) throw httpError(409, "Mark the booking completed before recording the payout");
      return updated;
    }

    case "read":
    case "archive": {
      if (actor !== "admin") break;
      return transition(
        b,
        ["new", "read", "archived"],
        { status: action === "read" ? "read" : "archived" },
        "Only old enquiries can be marked read or archived"
      );
    }
  }
  throw httpError(400, "Unknown action");
}

// ---------- Customer ----------

/** POST /api/models/bookings — a signed-in customer requests a model. */
export async function createBooking(req: Request, res: Response, next: NextFunction) {
  try {
    const b = req.body ?? {};
    const user = await User.findById(req.fan?.id);
    if (!user) return res.status(404).json({ message: "Account not found" });
    if (!b.modelId || !Types.ObjectId.isValid(String(b.modelId))) {
      return res.status(400).json({ message: "Please choose a model" });
    }
    const m = await ModelProfile.findOne({ _id: b.modelId, ...VISIBLE_MODEL });
    if (!m) return res.status(404).json({ message: "Model not available" });
    if (m.submittedBy && String(m.submittedBy) === String(user._id)) {
      return res.status(400).json({ message: "You can't book your own profile" });
    }

    const clientName = str(b.clientName, 120) || user.name;
    const phone = str(b.phone, 30) || user.phone;
    const date = String(b.date || "");
    const time = String(b.time || "");
    const location = str(b.location, 200);
    const eventType = str(b.eventType, 60);
    const durationHours = Number(b.durationHours);
    const modelsCount = b.modelsCount ? Math.floor(Number(b.modelsCount)) : 1;
    const offerGhs = Math.round(Number(b.offerGhs));
    const minOffer = m.rateGhs || MODELS_MARKET.minRateGhs;

    const problem = !clientName
      ? "Add your name"
      : !phone
      ? "Add a phone number — the model gets it once you've paid"
      : !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today()
      ? "Pick a date from today onwards"
      : !/^\d{2}:\d{2}$/.test(time)
      ? "Pick a start time"
      : !location
      ? "Add the shoot location"
      : !eventType
      ? "Choose the type of shoot"
      : !Number.isFinite(durationHours) || durationHours < 1 || durationHours > 24
      ? "Duration must be between 1 and 24 hours"
      : !Number.isFinite(modelsCount) || modelsCount < 1 || modelsCount > 50
      ? "Number of models must be between 1 and 50"
      : !Number.isFinite(offerGhs) || offerGhs < minOffer
      ? `${m.name}'s rate starts from ${ghs(minOffer)} — offer at least that`
      : null;
    if (problem) return res.status(400).json({ message: problem });

    const booking = await ModelBooking.create({
      modelId: m._id,
      modelName: m.name,
      customer: user._id,
      clientName,
      email: user.email,
      phone,
      date,
      time,
      location,
      eventType,
      durationHours,
      modelsCount,
      message: str(b.message, 2000),
      offerGhs,
      status: "requested",
    });

    const contact = await modelContact(m);
    void email(contact.email, {
      title: `New booking request from ${firstName(clientName)}`,
      intro:
        "Someone wants to book you through Dark Music Yard. Accept or decline it from your model dashboard — you'll get their contact details once they've paid.",
      pre: detailsText(booking),
      button: { label: "Open my dashboard", url: accountLink() },
    });
    void sendNotification(
      `New booking request — ${m.name}`,
      `From: ${clientName} (${user.email}, ${phone})\n${detailsText(booking)}` +
        (m.submittedBy
          ? ""
          : "\n\nThis model has no linked account — accept or decline it in the admin Bookings tab.")
    );

    res.status(201).json({ ok: true, id: booking._id });
  } catch (err) {
    next(err);
  }
}

async function ownBooking(req: Request): Promise<IModelBooking> {
  const id = String(req.params.id || "");
  const b = Types.ObjectId.isValid(id)
    ? await ModelBooking.findOne({ _id: id, customer: req.fan?.id })
    : null;
  if (!b) throw httpError(404, "Booking not found");
  return b;
}

async function customerView(b: IModelBooking) {
  const m = await ModelProfile.findById(b.modelId);
  const contact = m && CONTACT_OPEN.has(b.status) ? await modelContact(m) : null;
  return forCustomer(b, m, contact);
}

/** GET /api/account/bookings — the customer's bookings. */
export async function listMyBookings(req: Request, res: Response, next: NextFunction) {
  try {
    const bookings = await ModelBooking.find({ customer: req.fan?.id })
      .sort({ createdAt: -1 })
      .limit(100);
    const models = await ModelProfile.find({ _id: { $in: bookings.map((b) => b.modelId) } });
    const byId = new Map(models.map((m) => [String(m._id), m]));
    const out = await Promise.all(
      bookings.map(async (b) => {
        const m = byId.get(String(b.modelId));
        const contact = m && CONTACT_OPEN.has(b.status) ? await modelContact(m) : null;
        return forCustomer(b, m, contact);
      })
    );
    res.json(out);
  } catch (err) {
    next(err);
  }
}

/** POST /api/account/bookings/:id/pay — start Paystack checkout for an accepted booking. */
export async function payBooking(req: Request, res: Response, next: NextFunction) {
  try {
    const b = await ownBooking(req);
    if (b.status !== "accepted" || !b.priceGhs) {
      return res.status(409).json({
        message:
          b.status === "paid" || b.status === "completed"
            ? "This booking is already paid"
            : "This booking isn't waiting for payment",
      });
    }
    const reference = `DMY-BOOK-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    await ModelBooking.updateOne({ _id: b._id }, { $push: { paymentRefs: reference } });
    const init = await initializeTransaction({
      email: b.email,
      amountGhs: b.priceGhs,
      reference,
      callbackUrl: `${env.clientUrl}/account?booking=1`,
      metadata: { type: "model_booking", reference, bookingId: String(b._id) },
    });
    res.json({ authorizationUrl: init.authorizationUrl, reference, amountGhs: b.priceGhs });
  } catch (err) {
    next(err);
  }
}

async function announcePaid(b: IModelBooking) {
  const m = await ModelProfile.findById(b.modelId);
  const contact = m ? await modelContact(m) : { email: null, phone: null };
  void email(b.email, {
    title: `You're booked with ${b.modelName}`,
    intro: `Payment received — your booking is confirmed. Here's how to reach ${b.modelName} to sort out the final details.`,
    pre:
      `${detailsText(b)}\n\nModel contact` +
      (contact.phone ? `\nPhone / WhatsApp: ${contact.phone}` : "") +
      (contact.email ? `\nEmail: ${contact.email}` : ""),
    button: { label: "View booking", url: accountLink() },
    note: "Keep all payments for this booking on Dark Music Yard.",
  });
  void email(contact.email, {
    title: `Booking confirmed — ${firstName(b.clientName)} has paid`,
    intro: `You'll receive ${ghs(b.payoutGhs)} after the shoot (DMY keeps ${Math.round(
      MODELS_MARKET.commissionRate * 100
    )}%). Here are the customer's details.`,
    pre:
      `${detailsText(b)}\n\nCustomer contact\nName: ${b.clientName}\nEmail: ${b.email}` +
      (b.phone ? `\nPhone: ${b.phone}` : ""),
    button: { label: "Open my dashboard", url: accountLink() },
  });
  void sendNotification(
    `💰 Booking paid — ${b.modelName} · ${ghs(b.priceGhs)}`,
    `Customer: ${b.clientName} (${b.email})\nDMY commission: ${ghs(b.commissionGhs)}\nModel payout due after the shoot: ${ghs(b.payoutGhs)}\n\n${detailsText(b)}`
  );
}

/**
 * Confirm a booking payment exactly once (verify-on-return and the webhook may
 * both call this). Returns the booking, or null if the reference isn't a
 * booking — so the webhook can fall through to other payment types.
 */
export async function markBookingPaid(
  reference: string,
  paystackRef?: string,
  amountGhs?: number
): Promise<IModelBooking | null> {
  const existing = await ModelBooking.findOne({ paymentRefs: reference });
  if (!existing) return null;

  const amountOk = amountGhs === undefined || amountGhs >= (existing.priceGhs ?? 0);
  if (existing.status === "accepted" && amountOk) {
    const claimed = await ModelBooking.findOneAndUpdate(
      { _id: existing._id, status: "accepted" },
      { $set: { status: "paid", paidAt: new Date(), paystackRef: paystackRef || reference } },
      { new: true }
    );
    if (claimed) {
      await announcePaid(claimed);
      return claimed;
    }
    return ModelBooking.findById(existing._id); // another path confirmed it first
  }

  // Money arrived for a booking that can't take it (cancelled/declined meanwhile,
  // wrong amount, or a second payment) — flag it so DMY can refund.
  const paidTwice =
    (existing.status === "paid" || existing.status === "completed") &&
    existing.paystackRef &&
    existing.paystackRef !== (paystackRef || reference);
  if (paidTwice || (existing.status !== "paid" && existing.status !== "completed")) {
    void sendNotification(
      `⚠️ Booking payment needs attention — ${existing.modelName}`,
      `Paystack reference ${reference} was paid` +
        (amountGhs !== undefined ? ` (${ghs(amountGhs)})` : "") +
        `, but the booking is "${existing.status}"` +
        (paidTwice ? " and was already paid under another reference" : "") +
        (existing.priceGhs ? ` (agreed price ${ghs(existing.priceGhs)})` : "") +
        `. Check it and refund the customer if needed.\nCustomer: ${existing.clientName} (${existing.email})`
    );
  }
  return existing;
}

/** GET /api/account/bookings/verify?reference= — confirm payment on return from Paystack. */
export async function verifyBookingPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const reference = String(req.query.reference || "");
    const b = await ModelBooking.findOne({ paymentRefs: reference, customer: req.fan?.id });
    if (!b) return res.status(404).json({ message: "Booking not found" });

    let booking: IModelBooking = b;
    if (b.status === "accepted") {
      const result = await verifyTransaction(reference);
      if (result.paid) {
        booking = (await markBookingPaid(reference, result.reference, result.amountGhs)) ?? b;
      }
    }
    res.json(await customerView(booking));
  } catch (err) {
    next(err);
  }
}

/** POST /api/account/bookings/:id/cancel — the customer withdraws before paying. */
export async function cancelMyBooking(req: Request, res: Response, next: NextFunction) {
  try {
    const b = await ownBooking(req);
    const updated = await transition(
      b,
      ["requested", "accepted"],
      { status: "cancelled", cancelledAt: new Date(), cancelledBy: "customer" },
      "This booking can't be cancelled here any more — contact DMY if you need help"
    );
    const m = await ModelProfile.findById(updated.modelId);
    if (m) {
      void email((await modelContact(m)).email, {
        title: `${firstName(updated.clientName)} cancelled their booking request`,
        intro: "No action needed.",
        pre: detailsText(updated),
      });
    }
    res.json(await customerView(updated));
  } catch (err) {
    next(err);
  }
}

/** Recompute a model's average rating from their reviewed bookings. */
async function refreshModelRating(modelId: Types.ObjectId) {
  const [agg] = await ModelBooking.aggregate<{ avg: number; count: number }>([
    { $match: { modelId: new Types.ObjectId(String(modelId)), "review.stars": { $gte: 1 } } },
    { $group: { _id: null, avg: { $avg: "$review.stars" }, count: { $sum: 1 } } },
  ]);
  await ModelProfile.updateOne(
    { _id: modelId },
    { $set: { ratingAvg: agg?.avg ?? 0, ratingCount: agg?.count ?? 0 } }
  );
}

/** POST /api/account/bookings/:id/review — rate a completed booking (once). */
export async function reviewBooking(req: Request, res: Response, next: NextFunction) {
  try {
    const b = await ownBooking(req);
    const stars = Math.round(Number(req.body?.stars));
    if (!(stars >= 1 && stars <= 5)) {
      return res.status(400).json({ message: "Choose between 1 and 5 stars" });
    }
    const updated = await ModelBooking.findOneAndUpdate(
      { _id: b._id, status: "completed", "review.stars": { $exists: false } },
      { $set: { review: { stars, comment: str(req.body?.comment, 1000), createdAt: new Date() } } },
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({
        message: b.review
          ? "You've already reviewed this booking"
          : "You can leave a review once the booking is completed",
      });
    }
    await refreshModelRating(updated.modelId);
    res.json(await customerView(updated));
  } catch (err) {
    next(err);
  }
}

/** Latest reviews for a model's public profile (first names only). */
export async function publicReviews(modelId: unknown) {
  const reviewed = await ModelBooking.find({ modelId, "review.stars": { $gte: 1 } })
    .sort({ "review.createdAt": -1 })
    .limit(20);
  return reviewed.map((r) => ({
    stars: r.review!.stars,
    comment: r.review!.comment || null,
    name: firstName(r.clientName),
    date: r.review!.createdAt,
  }));
}

// ---------- Model dashboard ----------

const myProfile = (req: Request) =>
  ModelProfile.findOne({ submittedBy: req.fan?.id }).sort({ createdAt: -1 });

/** GET /api/account/model — the signed-in model's profile, bookings and earnings. */
export async function getMyModel(req: Request, res: Response, next: NextFunction) {
  try {
    const m = await myProfile(req);
    if (!m) return res.json({ profile: null, bookings: [], earnings: null });
    const bookings = await ModelBooking.find({ modelId: m._id, status: { $nin: LEGACY } })
      .sort({ createdAt: -1 })
      .limit(200);
    const sum = (list: IModelBooking[]) => list.reduce((s, b) => s + (b.payoutGhs ?? 0), 0);
    res.json({
      profile: privateModel(m),
      bookings: bookings.map(forModel),
      earnings: {
        dueGhs: sum(
          bookings.filter((b) => CONTACT_OPEN.has(b.status) && b.payoutStatus === "unpaid")
        ),
        paidOutGhs: sum(bookings.filter((b) => b.payoutStatus === "paid")),
        commissionRate: MODELS_MARKET.commissionRate,
      },
    });
  } catch (err) {
    next(err);
  }
}

// Registration requires these, so a model can't blank them out later.
const KEEP_FILLED: ModelFieldKey[] = ["phone", "location", "height", "weight", "availability", "rateGhs"];

/** PATCH /api/account/model — a model updates their own profile details. */
export async function updateMyModel(req: Request, res: Response, next: NextFunction) {
  try {
    const m = await myProfile(req);
    if (!m) return res.status(404).json({ message: "You don't have a model profile yet" });
    const { fields, error } = readModelFields(req.body ?? {}, SELF_EDITABLE);
    if (error) return res.status(400).json({ message: error });
    if (KEEP_FILLED.some((k) => k in fields && fields[k] === undefined)) {
      return res.status(400).json({ message: "Phone, location, height, weight, availability and rate can't be empty" });
    }
    if (fields.categories && fields.categories.length === 0) {
      return res.status(400).json({ message: "Pick at least one shoot type" });
    }
    m.set(fields);
    await m.save();
    res.json(privateModel(m));
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/account/model/bookings/:id — the model accepts, declines or completes. */
export async function respondAsModel(req: Request, res: Response, next: NextFunction) {
  try {
    const m = await myProfile(req);
    const id = String(req.params.id || "");
    const b =
      m && Types.ObjectId.isValid(id) ? await ModelBooking.findOne({ _id: id, modelId: m._id }) : null;
    if (!b) return res.status(404).json({ message: "Booking not found" });
    const action = String(req.body?.action || "");
    if (!["accept", "decline", "complete"].includes(action)) {
      return res.status(400).json({ message: "Unknown action" });
    }
    const updated = await applyBookingAction(b, action, req.body ?? {}, "model");
    res.json(forModel(updated));
  } catch (err) {
    next(err);
  }
}
