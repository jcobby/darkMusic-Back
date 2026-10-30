import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { Types } from "mongoose";
import { env } from "../config/env";
import { User } from "../models/User";
import { MOMO_NETWORKS, type MomoNetwork } from "../models/Wallet";
import { Promoter, PromoClick, PromoMonth, PromoSettings, PhoneCode, SmsSend, REJECT_REASONS } from "../models/Promoter";
import { isSmsConfigured, sendSms } from "../services/sms";
import { email, ghs, isMonth, maskMomo, monthEnd, monthLabel, normalizeMomo } from "../services/prizes";
import {
  REWARD_TIERS,
  IP_DAILY_CAP,
  rewardFor,
  monthOf,
  promoSettings,
  isYoutubeUrl,
  recordDevice,
  recheck,
  countClick,
} from "../services/promoter";

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const CODE_MINUTES = 10;
const MAX_TRIES = 5;
const SENDS_PER_DAY = 5;

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
  return {
    program: { open: settings.open, tiers: REWARD_TIERS, smsReady: isSmsConfigured(), ipDailyCap: IP_DAILY_CAP },
    code: user.referralCode,
    profilePhone: user.phone ?? null,
    promoter: p
      ? {
          phone: maskMomo(p.phone),
          status: p.status,
          reason: p.reason ?? null,
          momo: p.momo?.number ? { network: p.momo.network, number: maskMomo(p.momo.number), accountName: p.momo.accountName } : null,
          verifiedAt: p.verifiedAt,
        }
      : null,
    month: { month, clicks: months.find((m) => m.month === month)?.clicks ?? 0, endsAt: monthEnd(month) },
    history: months
      .filter((m) => m.month < month)
      .slice(0, 6)
      .map((m) => ({ month: m.month, clicks: m.clicks, rewardGhs: rewardFor(m.clicks), paidAt: m.paidAt ?? null })),
    pendingCode: !p && pending ? { phone: maskMomo(pending.phone), expiresAt: pending.expiresAt } : null,
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

/** POST /api/account/promoter/code { phone } — text a 6-digit code to their phone. */
export async function sendPhoneCode(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan!.id);
    if (await Promoter.exists({ user: userId })) throw httpError(409, "Your phone is already verified.");
    const phone = normalizeMomo(req.body?.phone);
    if (!phone) throw httpError(400, "Enter a Ghana mobile number, e.g. 024 123 4567");
    if (await Promoter.exists({ phone })) throw httpError(409, "That number is already verified on another account — one person, one account.");
    if (!isSmsConfigured()) throw httpError(503, "Phone verification isn't switched on yet — check back soon.");

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

/** POST /api/account/promoter/verify { code } — the right code switches their link on. */
export async function verifyPhoneCode(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = String(req.fan!.id);
    if (await Promoter.exists({ user: userId })) return res.json(await view(userId));
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
      await Promoter.create({ user: userId, phone: pending.phone, verifiedAt: new Date(), status: "active", links: [], cleared: [] });
    } catch {
      throw httpError(409, "That number is already verified on another account — one person, one account.");
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
    if (!p) throw httpError(400, "Verify your phone first.");
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

/** GET /api/promo — where links go, and the rewards. */
export async function promoInfo(_req: Request, res: Response, next: NextFunction) {
  try {
    const s = await promoSettings();
    res.json({ open: s.open, target: s.target, tiers: REWARD_TIERS });
  } catch (err) {
    next(err);
  }
}

/** POST /api/promo/click { code, vid } — someone opened a member's link (the page then sends them to YouTube). */
export async function promoClick(req: Request, res: Response, next: NextFunction) {
  try {
    const code = String(req.body?.code || "").trim();
    await countClick(req, code, req.body?.vid);
    res.json({ target: (await promoSettings()).target }); // the same answer either way — nothing to learn from it
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
          phone: p.phone,
          verifiedAt: p.verifiedAt,
          status: p.status,
          reason: p.reason ?? null,
          manual: Boolean(p.manual),
          links: p.links.map((l) => ({ kind: l.kind, at: l.at, cleared: p.cleared.some((c) => String(c) === String(l.other)), other: person(l.other) })),
          momo: p.momo?.number ? p.momo : null,
          clicks,
          ips: ipRows.find((r) => String(r._id) === String(p.user))?.ips ?? 0,
          rejected: Object.fromEntries(REJECT_REASONS.map((r) => [r, m?.rejected?.[r] ?? 0])),
          rewardGhs: reward,
          eligible: reward > 0 && p.status === "active",
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
      settings: { open: settings.open, target: settings.target },
      tiers: REWARD_TIERS,
      ipDailyCap: IP_DAILY_CAP,
      smsReady: isSmsConfigured(),
      totals: {
        promoters: rows.length,
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

/** PUT /api/admin/promoters/settings { open?, target? } */
export async function adminPromoterSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const set: Record<string, unknown> = {};
    if (req.body?.open !== undefined) set.open = Boolean(req.body.open);
    if (req.body?.target !== undefined) {
      if (!isYoutubeUrl(req.body.target)) throw httpError(400, "Use a YouTube link (https://www.youtube.com/… or https://youtu.be/…)");
      set.target = String(req.body.target).trim();
    }
    const s = await PromoSettings.findByIdAndUpdate("settings", { $set: set }, { upsert: true, new: true, setDefaultsOnInsert: true });
    res.json({ open: s.open, target: s.target });
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

/** POST /api/admin/promoters/:user/paid { month, paid, note? } — after paying a reward (or to undo it). */
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
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
