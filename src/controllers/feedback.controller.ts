import { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import { env, isEmailConfigured } from "../config/env";
import { Feedback, type IFeedback } from "../models/Feedback";
import { User } from "../models/User";
import { sendMail } from "../services/mailer";
import { renderEmail, renderText } from "../services/emailTemplates";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const isEmail = (v: unknown) => typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());

function deviceOf(ua: string): IFeedback["device"] {
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android/i.test(ua)) return "phone";
  return "desktop";
}

/**
 * POST /api/feedback { message, rating?, page?, name?, email? } — from the Feedback
 * button on every page. Signed-in fans are linked to their account automatically.
 */
export async function submitFeedback(req: Request, res: Response, next: NextFunction) {
  try {
    const b = req.body ?? {};
    // Hidden field people never see: a bot fills it in, so pretend it worked and drop it.
    if (b.website) return res.status(201).json({ ok: true });

    const message = String(b.message ?? "").trim();
    if (message.length < 3) throw httpError(400, "Tell us a little more");
    if (message.length > 2000) throw httpError(400, "Please keep it under 2,000 characters");
    const rating = b.rating === undefined || b.rating === null || b.rating === "" ? null : Math.round(Number(b.rating));
    if (rating !== null && !(rating >= 1 && rating <= 5)) throw httpError(400, "Pick from 1 to 5 stars");
    const typedEmail = String(b.email ?? "").trim();
    if (typedEmail && !isEmail(typedEmail)) throw httpError(400, "That email address doesn't look right");

    const user = req.fan?.id && Types.ObjectId.isValid(req.fan.id) ? await User.findById(req.fan.id).select("name email") : null;
    const ua = String(req.headers["user-agent"] || "");
    const page = String(b.page || "/");
    await Feedback.create({
      user: user?._id ?? null,
      name: (user?.name || String(b.name ?? "").trim() || undefined)?.slice(0, 80),
      email: user?.email ?? (typedEmail ? typedEmail.toLowerCase() : undefined),
      rating,
      message,
      page: page.startsWith("/") ? page.slice(0, 300) : "/",
      device: deviceOf(ua),
      userAgent: ua.slice(0, 300),
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/feedback — newest first, with the average rating and counts. */
export async function adminListFeedback(_req: Request, res: Response, next: NextFunction) {
  try {
    const [items, total, open, rated] = await Promise.all([
      Feedback.find().sort({ createdAt: -1 }).limit(300).populate<{ user: { _id: Types.ObjectId; name?: string; email: string } | null }>("user", "name email"),
      Feedback.countDocuments(),
      Feedback.countDocuments({ status: "new" }),
      Feedback.aggregate<{ _id: number; n: number }>([{ $match: { rating: { $ne: null } } }, { $group: { _id: "$rating", n: { $sum: 1 } } }]),
    ]);
    const ratedCount = rated.reduce((s, r) => s + r.n, 0);
    res.json({
      total,
      open,
      averageRating: ratedCount ? Math.round((rated.reduce((s, r) => s + r._id * r.n, 0) / ratedCount) * 10) / 10 : null,
      ratings: Object.fromEntries([1, 2, 3, 4, 5].map((s) => [s, rated.find((r) => r._id === s)?.n ?? 0])),
      items: items.map((f) => ({
        id: String(f._id),
        rating: f.rating ?? null,
        message: f.message,
        page: f.page,
        device: f.device,
        status: f.status,
        name: f.user?.name ?? f.name ?? null,
        email: f.user?.email ?? f.email ?? null,
        userId: f.user ? String(f.user._id) : null,
        createdAt: f.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/admin/feedback/:id { status: "new" | "done" } */
export async function updateFeedback(req: Request, res: Response, next: NextFunction) {
  try {
    const status = req.body?.status === "done" ? "done" : "new";
    if (!Types.ObjectId.isValid(String(req.params.id))) throw httpError(400, "Invalid id");
    const f = await Feedback.findByIdAndUpdate(req.params.id, { $set: { status } }, { new: true });
    if (!f) throw httpError(404, "Feedback not found");
    res.json({ ok: true, status: f.status });
  } catch (err) {
    next(err);
  }
}

// At most one feedback email a day: email is on a small monthly allowance (EmailJS),
// so new feedback is collected and sent together.
const DIGEST_EVERY_MS = 24 * 60 * 60 * 1000;
let digesting = false;

/** Called by the once-a-minute sweeper: emails DMY the feedback not yet sent, if a day has passed since the last email. */
export async function sendFeedbackDigest(): Promise<void> {
  if (digesting || !isEmailConfigured()) return;
  digesting = true;
  try {
    const pending = await Feedback.find({ notifiedAt: null }).sort({ createdAt: 1 }).limit(50);
    if (!pending.length) return;
    const last = await Feedback.findOne({ notifiedAt: { $ne: null } }).sort({ notifiedAt: -1 });
    if (last?.notifiedAt && Date.now() - last.notifiedAt.getTime() < DIGEST_EVERY_MS) return;

    const stars = (n?: number | null) => (n ? `${"★".repeat(n)}${"☆".repeat(5 - n)} ` : "");
    const pre = pending
      .map((f) => `${stars(f.rating)}${f.message}\n— ${f.name || f.email || "a visitor"} · ${f.page} · ${f.device}`)
      .join("\n\n");
    const content = {
      title: `${pending.length} new feedback message${pending.length === 1 ? "" : "s"}`,
      intro: "Here's what visitors said through the site's Feedback button:",
      pre,
      button: { label: "Open admin → Feedback", url: `${env.clientUrl}/admin` },
    };
    const sent = await sendMail(env.contactEmail, `💬 ${content.title} on Dark Music Yard`, renderText(content), renderEmail(content));
    if (sent) await Feedback.updateMany({ _id: { $in: pending.map((f) => f._id) } }, { $set: { notifiedAt: new Date() } });
  } finally {
    digesting = false;
  }
}
