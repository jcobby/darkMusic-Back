import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { Types } from "mongoose";
import { env, isCloudinaryConfigured } from "../config/env";
import { User } from "../models/User";
import { MOMO_NETWORKS, type MomoNetwork } from "../models/Wallet";
import { Promoter, PromoClick, PromoMonth, PromoSettings, PhoneCode, SmsSend, REJECT_REASONS, type IPromoter } from "../models/Promoter";
import { uploadPrivateImage, privateImageUrl, deletePrivateImage } from "../services/cloudinary";
import { sendNotification } from "../services/mailer";
import { email, ghs, isMonth, maskMomo, monthEnd, monthLabel, normalizeMomo } from "../services/prizes";
import { isSmsConfigured, sendSms, textMember, smsGhs } from "../services/sms";
import {
  REWARD_TIERS,
  IP_DAILY_CAP,
  rewardFor,
  monthOf,
  promoSettings,
  pickTarget,
  isYoutubeUrl,
  recordDevice,
  recheck,
  countClick,
  normalizeGhanaCard,
  cardHash,
  maskCard,
  canEarn,
} from "../services/promoter";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const MAX_PHOTO_MB = 8;
const CARD_TAKEN = "That Ghana Card is already on another account — one person, one account. If it's yours, contact DMY.";
const PHONE_TAKEN = "That number is already confirmed on another account — one person, one account. If it's yours, contact DMY.";
const CODE_MINUTES = 10;
const MAX_TRIES = 5;
const SENDS_PER_DAY = 5;
/** "0241234567" → "024 123 4567" */
const spaced = (n: string) => `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;

/** Delete a card photo, quietly (it's only ever kept until DMY decides). */
const dropPhoto = (photo?: { id?: string } | null) => {
  if (photo?.id) void deletePrivateImage(photo.id).catch((err) => console.error("[promoter] couldn't delete a card photo:", err));
};

// ---------- The member's dashboard ----------

async function view(userId: string) {
  const [user, p, settings, months, pending] = await Promise.all([
    User.findById(userId).select("referralCode phone").lean(),
    Promoter.findOne({ user: userId }).lean(),
    promoSettings(),
    PromoMonth.find({ user: userId }).sort({ month: -1 }).limit(7).lean(),
    PhoneCode.findOne({ user: userId, expiresAt: { $gt: new Date() } }).lean(),
  ]);
  if (!user) throw httpError(404, "Account not found");
  const month = monthOf();
  const profilePhone = normalizeMomo(user.phone);
  return {
    program: { open: settings.open, tiers: REWARD_TIERS, cardReady: isCloudinaryConfigured(), smsReady: isSmsConfigured(), ipDailyCap: IP_DAILY_CAP },
    code: user.referralCode,
    profilePhone: profilePhone ? spaced(profilePhone) : null, // to fill in the phone step
    pendingCode: pending && !p?.phone ? { phone: spaced(pending.phone), expiresAt: pending.expiresAt } : null,
    promoter: p
      ? {
          status: p.status,
          reason: p.reason ?? null,
          phone: p.phone ? maskMomo(p.phone) : null, // confirmed by a texted code
          card: p.card?.status
            ? { status: p.card.status, masked: p.card.masked, note: p.card.note ?? null, submittedAt: p.card.submittedAt, reviewedAt: p.card.reviewedAt ?? null }
            : null,
          canEarn: canEarn(p),
          momo: p.momo?.number ? { network: p.momo.network, number: maskMomo(p.momo.number), accountName: p.momo.accountName } : null,
        }
      : null,
    month: { month, clicks: months.find((m) => m.month === month)?.clicks ?? 0, endsAt: monthEnd(month) },
    history: months
      .filter((m) => m.month < month)
      .slice(0, 6)
      .map((m) => ({ month: m.month, clicks: m.clicks, rewardGhs: rewardFor(m.clicks), paidAt: m.paidAt ?? null })),
  };
}

/** GET /api/account/promoter */
export async function myPromoter(req: Request, res: Response, next: NextFunction) {
  try {
    void recordDevice(String(req.fan!.id), req);
    res.json(await view(String(req.fan!.id)));
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/account/promoter/card — multipart { number, photo }: their Ghana Card. Their link
 * starts counting straight away; DMY checks the photo, and rewards are paid once it's approved.
 */
export async function submitGhanaCard(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan!.id);
    const number = normalizeGhanaCard(req.body?.number);
    if (!number) throw httpError(400, "Enter your Ghana Card number as it is on the card, e.g. GHA-123456789-0");
    const file = req.file;
    if (!file) throw httpError(400, "Add a clear photo of the front of your Ghana Card");
    if (!/^image\//.test(file.mimetype)) throw httpError(400, "The photo must be a picture (JPG or PNG)");
    if (file.size > MAX_PHOTO_MB * 1024 * 1024) throw httpError(400, `The photo is too big — under ${MAX_PHOTO_MB} MB please`);

    const existing = await Promoter.findOne({ user: userId });
    if (existing?.card?.status === "approved") throw httpError(409, "Your Ghana Card is already approved.");
    const hash = cardHash(number);
    if (await Promoter.exists({ "card.hash": hash, user: { $ne: userId } })) throw httpError(409, CARD_TAKEN);
    if (!isCloudinaryConfigured()) throw httpError(503, "Ghana Card checks aren't switched on yet — try again soon.");

    const photo = await uploadPrivateImage(file.buffer, "dmy/id-cards");
    const card = { hash, masked: maskCard(number), photo, status: "pending" as const, submittedAt: new Date() };
    try {
      if (existing) {
        dropPhoto({ id: existing.card?.photo?.id }); // a new photo replaces the last one (id copied before the field changes)
        existing.card = card;
        await existing.save();
      } else {
        await Promoter.create({ user: userId, card, status: "active", links: [], cleared: [] });
      }
    } catch {
      dropPhoto(photo);
      throw httpError(409, CARD_TAKEN); // the same card sent from another account at the same moment
    }
    await recordDevice(userId, req);
    await recheck(userId);
    const user = await User.findById(userId).select("name email").lean();
    void sendNotification(
      `🪪 Ghana Card to check — ${user?.name || user?.email || "a member"}`,
      `${user?.name || "A member"} (${user?.email ?? "unknown"}) sent their Ghana Card for the Lenko Army promoter program. ` +
        `Check the photo in admin → LA Promoters and approve it (or turn it down) — their rewards wait for it.`
    ).catch(() => {});
    res.json(await view(userId));
  } catch (err) {
    next(err);
  }
}

/** POST /api/account/promoter/code { phone } — text a 6-digit code to the number they want to confirm. */
export async function sendPhoneCode(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan!.id);
    if ((await Promoter.findOne({ user: userId }).select("phone").lean())?.phone) throw httpError(409, "Your phone is already confirmed.");
    const phone = normalizeMomo(req.body?.phone);
    if (!phone) throw httpError(400, "Enter a Ghana mobile number, e.g. 024 123 4567");
    if (await Promoter.exists({ phone, user: { $ne: userId } })) throw httpError(409, PHONE_TAKEN);
    if (!isSmsConfigured()) throw httpError(503, "Phone checks aren't switched on yet — try again soon.");

    const dayAgo = new Date(Date.now() - 86400e3);
    const [last, mine, toNumber] = await Promise.all([
      SmsSend.findOne({ user: userId }).sort({ at: -1 }).lean(),
      SmsSend.countDocuments({ user: userId, at: { $gt: dayAgo } }),
      SmsSend.countDocuments({ phone, at: { $gt: dayAgo } }),
    ]);
    if (last && Date.now() - last.at.getTime() < 60e3) throw httpError(429, "Wait a minute before asking for another code.");
    if (mine >= SENDS_PER_DAY || toNumber >= SENDS_PER_DAY) throw httpError(429, "That's the most codes for today — try again tomorrow.");

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const sent = await sendSms(
      phone,
      `${code} is your Dark Music Yard code for the Lenko Army promoter program. It expires in ${CODE_MINUTES} minutes. Don't share it with anyone.`
    );
    if (!sent) throw httpError(502, "Couldn't send the text right now — try again shortly.");
    await Promise.all([
      SmsSend.create({ user: userId, phone, at: new Date() }),
      PhoneCode.findOneAndUpdate(
        { user: userId },
        { $set: { phone, codeHash: sha(`${userId}:${code}`), expiresAt: new Date(Date.now() + CODE_MINUTES * 60e3), attempts: 0 } },
        { upsert: true }
      ),
    ]);
    res.json(await view(userId));
  } catch (err) {
    next(err);
  }
}

/** POST /api/account/promoter/verify { code } — the right code confirms their phone (and switches their link on, if the card hasn't). */
export async function verifyPhoneCode(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan!.id);
    if ((await Promoter.findOne({ user: userId }).select("phone").lean())?.phone) return res.json(await view(userId));
    const pending = await PhoneCode.findOne({ user: userId, expiresAt: { $gt: new Date() } });
    if (!pending) throw httpError(400, "That code has expired — ask for a new one.");
    if (pending.attempts >= MAX_TRIES) {
      await pending.deleteOne();
      throw httpError(429, "Too many wrong codes — ask for a new one.");
    }
    const given = String(req.body?.code ?? "").replace(/\D/g, "");
    const ok = given.length === 6 && crypto.timingSafeEqual(Buffer.from(sha(`${userId}:${given}`)), Buffer.from(pending.codeHash));
    if (!ok) {
      pending.attempts += 1;
      await pending.save();
      throw httpError(400, `That code isn't right${pending.attempts < MAX_TRIES ? ` — ${MAX_TRIES - pending.attempts} tries left` : ""}.`);
    }
    try {
      await Promoter.updateOne(
        { user: userId },
        { $set: { phone: pending.phone, phoneVerifiedAt: new Date() }, $setOnInsert: { status: "active", links: [], cleared: [] } },
        { upsert: true }
      );
    } catch {
      throw httpError(409, PHONE_TAKEN); // confirmed on another account at the same moment
    }
    await pending.deleteOne();
    await recordDevice(userId, req);
    await recheck(userId);
    res.json(await view(userId));
  } catch (err) {
    next(err);
  }
}

/** PUT /api/account/promoter/payout { network, number, accountName } — where rewards are paid. */
export async function setPromoterPayout(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan!.id);
    const p = await Promoter.findOne({ user: userId });
    if (!p) throw httpError(400, "Confirm your phone or send your Ghana Card first.");
    const network = String(req.body?.network || "") as MomoNetwork;
    if (!MOMO_NETWORKS.includes(network)) throw httpError(400, "Choose your Mobile Money network");
    const number = normalizeMomo(req.body?.number);
    if (!number) throw httpError(400, "Enter a valid Ghana Mobile Money number, e.g. 024 123 4567");
    const accountName = String(req.body?.accountName || "").trim().replace(/\s+/g, " ").slice(0, 80);
    if (accountName.length < 3) throw httpError(400, "Enter the name on the Mobile Money account");
    p.momo = { network, number, accountName };
    await p.save();
    await recheck(userId);
    res.json(await view(userId));
  } catch (err) {
    next(err);
  }
}

// ---------- The link (public) ----------

/** GET /api/promo — where links go (`target`: one of them, for a page that only takes one), and the rewards. */
export async function promoInfo(_req: Request, res: Response, next: NextFunction) {
  try {
    const s = await promoSettings();
    res.json({ open: s.open, target: pickTarget(s.targets), targets: s.targets, tiers: REWARD_TIERS });
  } catch (err) {
    next(err);
  }
}

/** POST /api/promo/click { code, vid } — someone opened a member's link (the page then sends them to YouTube). */
export async function promoClick(req: Request, res: Response, next: NextFunction) {
  try {
    const code = String(req.body?.code || "").trim();
    await countClick(req, code, req.body?.vid);
    res.json({ target: pickTarget((await promoSettings()).targets) }); // the same kind of answer either way — nothing to learn from it
  } catch (err) {
    next(err);
  }
}

// ---------- Admin ----------

/** GET /api/admin/promoters?month= — every member with their clicks that month, who qualifies, and any duplicate accounts. */
export async function adminPromoters(req: Request, res: Response, next: NextFunction) {
  try {
    const month = isMonth(req.query.month) ? String(req.query.month) : monthOf();
    const [settings, promoters, months, ipRows, allMonths] = await Promise.all([
      promoSettings(),
      Promoter.find().lean(),
      PromoMonth.find({ month }).lean(),
      PromoClick.aggregate<{ _id: Types.ObjectId; ips: number }>([
        { $match: { month } },
        { $group: { _id: "$promoter", ips: { $addToSet: "$ip" } } },
        { $project: { ips: { $size: "$ips" } } },
      ]),
      PromoMonth.distinct("month"),
    ]);
    const ids = new Set<string>();
    for (const p of promoters) {
      ids.add(String(p.user));
      for (const l of p.links) ids.add(String(l.other));
    }
    const users = new Map(
      (await User.find({ _id: { $in: [...ids] } }).select("name email phone referralCode").lean()).map((u) => [String(u._id), u])
    );
    const person = (id: unknown) => {
      const u = users.get(String(id));
      return { id: String(id), name: u?.name ?? null, email: u?.email ?? "(deleted account)" };
    };
    const ended = month < monthOf();
    const rows = promoters
      .map((p) => {
        const m = months.find((x) => String(x.user) === String(p.user));
        const clicks = m?.clicks ?? 0;
        const reward = rewardFor(clicks);
        const u = users.get(String(p.user));
        return {
          ...person(p.user),
          code: u?.referralCode ?? null,
          profilePhone: u?.phone ?? null,
          phone: p.phone ?? null, // confirmed by a texted code
          joinedAt: p.createdAt,
          card: p.card?.status
            ? {
                status: p.card.status,
                masked: p.card.masked,
                note: p.card.note ?? null,
                submittedAt: p.card.submittedAt,
                reviewedAt: p.card.reviewedAt ?? null,
                // Only while it waits for DMY, and only for half an hour
                photoUrl: p.card.photo?.id ? privateImageUrl(p.card.photo.id, p.card.photo.format) : null,
              }
            : null,
          status: p.status,
          reason: p.reason ?? null,
          manual: Boolean(p.manual),
          links: p.links.map((l) => ({ kind: l.kind, at: l.at, cleared: p.cleared.some((c) => String(c) === String(l.other)), other: person(l.other) })),
          momo: p.momo?.number ? p.momo : null,
          clicks,
          ips: ipRows.find((r) => String(r._id) === String(p.user))?.ips ?? 0,
          rejected: Object.fromEntries(REJECT_REASONS.map((r) => [r, m?.rejected?.[r] ?? 0])),
          rewardGhs: reward,
          eligible: reward > 0 && canEarn(p),
          paidAt: m?.paidAt ?? null,
          paidGhs: m?.paidGhs ?? null,
          paidNote: m?.paidNote ?? null,
        };
      })
      .sort((a, b) => b.clicks - a.clicks || String(a.name).localeCompare(String(b.name)));
    const eligible = rows.filter((r) => r.eligible);
    res.json({
      month,
      ended,
      months: [...new Set([monthOf(), ...allMonths])].sort().reverse(),
      settings: { open: settings.open, targets: settings.targets },
      tiers: REWARD_TIERS,
      ipDailyCap: IP_DAILY_CAP,
      cardReady: isCloudinaryConfigured(),
      totals: {
        promoters: rows.length,
        cardsToCheck: rows.filter((r) => r.card?.status === "pending").length,
        disqualified: rows.filter((r) => r.status === "disqualified").length,
        clicks: rows.reduce((s, r) => s + r.clicks, 0),
        hit: Object.fromEntries(REWARD_TIERS.map((t) => [t.clicks, eligible.filter((r) => r.clicks >= t.clicks).length])),
        payoutGhs: eligible.reduce((s, r) => s + r.rewardGhs, 0),
        paidGhs: rows.reduce((s, r) => s + (r.paidGhs ?? 0), 0),
      },
      rows,
    });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/admin/promoters/settings { open?, targets? } (or the older single `target`) */
export async function adminPromoterSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const set: Record<string, unknown> = {};
    if (req.body?.open !== undefined) set.open = Boolean(req.body.open);
    const raw = req.body?.targets ?? (req.body?.target !== undefined ? [req.body.target] : undefined);
    if (raw !== undefined) {
      const targets = (Array.isArray(raw) ? raw : []).map((t) => String(t).trim()).filter(Boolean);
      if (!targets.length) throw httpError(400, "Add at least one YouTube link");
      if (targets.length > 20) throw httpError(400, "20 links at most");
      const bad = targets.find((t): boolean => !isYoutubeUrl(t));
      if (bad) throw httpError(400, `Not a YouTube link: ${bad.slice(0, 80)} (use https://www.youtube.com/… or https://youtu.be/…)`);
      set.targets = [...new Set(targets)];
    }
    const s = await PromoSettings.findByIdAndUpdate("settings", { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.json({ open: s.open, targets: s.targets });
  } catch (err) {
    next(err);
  }
}

const promoterOf = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) throw httpError(404, "Not found");
  const p = await Promoter.findOne({ user: id });
  if (!p) throw httpError(404, "That member isn't in the promoter program");
  return p;
};

/** POST /api/admin/promoters/:user/status { action: "disqualify" | "reinstate", reason? } */
export async function adminPromoterStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const p = await promoterOf(String(req.params.user));
    if (req.body?.action === "disqualify") {
      p.manual = true;
      p.status = "disqualified";
      p.reason = String(req.body?.reason || "").trim().slice(0, 200) || "Disqualified by DMY";
      await p.save();
    } else if (req.body?.action === "reinstate") {
      p.manual = false;
      await p.save();
      await recheck(p.user, false); // still disqualified if an uncleared duplicate remains
    } else throw httpError(400, "Unknown action");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/promoters/:user/card { action: "approve" | "reject", note? } — after looking at
 * their Ghana Card photo. Either way the photo is deleted; the member is emailed.
 */
export async function adminPromoterCard(req: Request, res: Response, next: NextFunction) {
  try {
    const p = await promoterOf(String(req.params.user));
    if (!p.card?.status) throw httpError(400, "They haven't sent a Ghana Card");
    const action = req.body?.action;
    const note = String(req.body?.note || "").trim().slice(0, 200);
    if (action !== "approve" && action !== "reject") throw httpError(400, "Unknown action");
    if (action === "reject" && !note) throw httpError(400, "Say why, so they can fix it (e.g. the photo is blurry)");
    const photoId = p.card.photo?.id; // copied: clearing the field below empties Mongoose's live object
    p.card.status = action === "approve" ? "approved" : "rejected";
    p.card.note = action === "reject" ? note : undefined;
    p.card.reviewedAt = new Date();
    p.card.photo = undefined;
    if (action === "reject") (p.card as Partial<NonNullable<IPromoter["card"]>>).hash = undefined; // the number is free again for the right person
    await p.save();
    if (photoId) await deletePrivateImage(photoId).catch((err) => console.error("[promoter] couldn't delete a card photo:", err));
    const user = await User.findById(p.user).select("email name").lean();
    void email(
      user?.email,
      action === "approve"
        ? {
            title: "Your Ghana Card is approved ✓",
            intro: `Hi ${user?.name || "Lenko Army"} — your Ghana Card is checked, so your promoter rewards are switched on. Keep sharing your link!`,
            button: { label: "See my clicks", url: `${env.clientUrl}/community/promote` },
          }
        : {
            title: "We couldn't approve your Ghana Card",
            intro: `Hi ${user?.name || "Lenko Army"} — we couldn't approve the Ghana Card you sent: ${note}. Send it again from your promoter page — your link keeps counting meanwhile.`,
            button: { label: "Send it again", url: `${env.clientUrl}/community/promote` },
          }
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/promoters/:user/clear { other } — DMY checked: these two accounts are different people. */
export async function adminPromoterClear(req: Request, res: Response, next: NextFunction) {
  try {
    const p = await promoterOf(String(req.params.user));
    const other = String(req.body?.other || "");
    if (!Types.ObjectId.isValid(other)) throw httpError(400, "Which account?");
    await Promoter.updateOne({ _id: p._id }, { $addToSet: { cleared: new Types.ObjectId(other) } });
    await Promoter.updateOne({ user: other }, { $addToSet: { cleared: p.user } });
    await recheck(p.user, false);
    await recheck(other, false);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/promoters/:user/paid { month, paid, note? } — after paying a reward (or to undo it). The member gets an email and a text. */
export async function adminPromoterPaid(req: Request, res: Response, next: NextFunction) {
  try {
    const p = await promoterOf(String(req.params.user));
    const month = String(req.body?.month || "");
    if (!isMonth(month) || month >= monthOf()) throw httpError(400, "Rewards are paid once the month is over");
    if (req.body?.paid === false) {
      await PromoMonth.updateOne({ user: p.user, month }, { $unset: { paidAt: "", paidGhs: "", paidNote: "" } });
      return res.json({ ok: true });
    }
    const m = await PromoMonth.findOne({ user: p.user, month });
    const reward = rewardFor(m?.clicks ?? 0);
    if (!m || reward <= 0) throw httpError(400, "They didn't reach a reward that month");
    if (p.status !== "active") throw httpError(400, "They're disqualified — reinstate them first");
    if (p.card?.status !== "approved") throw httpError(400, "Approve their Ghana Card first");
    if (!p.phone) throw httpError(400, "They haven't confirmed their phone by text yet");
    if (m.paidAt) return res.json({ ok: true });
    m.paidAt = new Date();
    m.paidGhs = reward;
    m.paidNote = String(req.body?.note || "").trim().slice(0, 200) || undefined;
    await m.save();
    const user = await User.findById(p.user).select("email name").lean();
    void email(user?.email, {
      title: `Your ${ghs(reward)} promoter reward is on its way 🎉`,
      intro:
        `Hi ${user?.name || "Lenko Army"} — your link got ${m.clicks.toLocaleString("en-US")} clicks in ${monthLabel(month)}, ` +
        `so DMY has sent your ${ghs(reward)} reward${p.momo?.number ? ` to ${p.momo.network} Mobile Money ${maskMomo(p.momo.number)}` : ""}. Thanks for repping the Lenko Army!`,
      button: { label: "Keep promoting", url: `${env.clientUrl}/community/promote` },
    });
    void textMember(
      p.user,
      `DMY: Your ${smsGhs(reward)} Lenko Army promoter reward for ${monthLabel(month)} has been sent` +
        `${p.momo?.number ? ` to your ${p.momo.network} MoMo ${maskMomo(p.momo.number)}` : ""}. Thanks for repping!`
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
