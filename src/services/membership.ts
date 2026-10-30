import { env } from "../config/env";
import { Membership, type IMembership } from "../models/Membership";
import { User, type IUser } from "../models/User";
import { sendMail } from "./mailer";
import { renderEmail, renderText, type EmailContent } from "./emailTemplates";

/*
 * DMY membership — the games stay free for everyone; fans can choose to support monthly:
 *  - 💜 Supporter GH₵10: a badge next to their name on every board, and a supporter frame
 *    on their Lenko Army card;
 *  - 💎 VIP GH₵25: the same with a VIP badge, plus exclusive Pool cue designs;
 *  - 👑 Legend GH₵50: all of that, extra name colours, and their name on the Supporter Wall.
 * A month is a one-time Paystack payment (Mobile Money or card — nothing renews by itself),
 * like the streaming pass: 30 days, extended if they renew the same tier before it ends.
 * A few days before the end they get a reminder email.
 */

export type Tier = "supporter" | "vip" | "legend";
export const TIERS: Record<Tier, { label: string; badge: string; priceGhs: number; perks: string[] }> = {
  supporter: { label: "Supporter", badge: "💜", priceGhs: 10, perks: ["💜 Supporter badge next to your name on every board", "A supporter frame on your Lenko Army card"] },
  vip: { label: "VIP", badge: "💎", priceGhs: 25, perks: ["💎 VIP badge next to your name on every board", "A VIP frame on your Lenko Army card", "4 exclusive Pool cue designs"] },
  legend: {
    label: "Legend",
    badge: "👑",
    priceGhs: 50,
    perks: ["👑 Legend badge next to your name on every board", "A Legend frame on your Lenko Army card", "Every exclusive Pool cue", "Extra Legend name colours", "Your name on the Supporter Wall"],
  },
};
export const TIER_ORDER: Tier[] = ["supporter", "vip", "legend"];
export const isTier = (v: unknown): v is Tier => typeof v === "string" && Object.hasOwn(TIERS, v);
export const MEMBER_DAYS = 30;
const REMIND_DAYS = 3;
const DAY = 86400e3;

/** Their tier if the membership is still running. */
export const activeTier = (u: Pick<IUser, "memberTier" | "memberUntil">, now = Date.now()): Tier | null =>
  u.memberTier && u.memberUntil && u.memberUntil.getTime() > now ? u.memberTier : null;
/** Does this tier include that one's perks? */
export const tierAtLeast = (tier: Tier | null, min: Tier) => tier !== null && TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(min);

/** Pool cue designs: the classic one for everyone, the rest for VIPs and Legends. */
export const CUE_DESIGNS = {
  classic: { label: "Classic", tier: null },
  gold: { label: "Gold", tier: "vip" },
  neon: { label: "Neon purple", tier: "vip" },
  lenko: { label: "Lenko black", tier: "vip" },
  diamond: { label: "Diamond", tier: "vip" },
} as const satisfies Record<string, { label: string; tier: Tier | null }>;
export type CueDesign = keyof typeof CUE_DESIGNS;
export const isCueDesign = (v: unknown): v is CueDesign => typeof v === "string" && Object.hasOwn(CUE_DESIGNS, v);
/** The cue they can use now: their pick if their membership covers it, otherwise the classic. */
export function cueFor(u: Pick<IUser, "cueDesign" | "memberTier" | "memberUntil">): CueDesign {
  const pick = isCueDesign(u.cueDesign) ? u.cueDesign : "classic";
  const need = CUE_DESIGNS[pick].tier;
  return need === null || tierAtLeast(activeTier(u), need) ? pick : "classic";
}

const fmtDay = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Africa/Accra" });

function email(to: string, subject: string, content: EmailContent) {
  return sendMail(to, subject, renderText(content), renderEmail(content)).catch(() => false);
}

/**
 * Claim a membership payment exactly once and apply it: renewing the same tier adds 30
 * days to what's left; a new (or different) tier runs 30 days from now. Returns the
 * payment if the reference is a membership (just claimed or already paid), else null —
 * so the Paystack webhook can fall through to other payment types.
 */
export async function markMembershipPaid(reference: string, paystackRef?: string): Promise<IMembership | null> {
  const claimed = await Membership.findOneAndUpdate(
    { reference, status: { $ne: "paid" } },
    { $set: { status: "paid", ...(paystackRef ? { paystackRef } : {}) } },
    { new: true }
  );
  if (!claimed) return Membership.findOne({ reference });
  const user = await User.findById(claimed.user);
  if (user) {
    const now = Date.now();
    const renewing = activeTier(user, now) === claimed.tier;
    const from = renewing && user.memberUntil ? user.memberUntil.getTime() : now;
    user.memberTier = claimed.tier;
    user.memberUntil = new Date(from + MEMBER_DAYS * DAY);
    user.memberRemindedFor = undefined;
    await user.save();
    await Membership.updateOne({ _id: claimed._id }, { $set: { until: user.memberUntil } });
    const t = TIERS[claimed.tier];
    void email(user.email, `You're a DMY ${t.label} ${t.badge}`, {
      title: `Thank you — you're a ${t.label} ${t.badge}`,
      intro: `Thanks for supporting Dark Music Yard, ${user.name || "Lenko Army"}! You keep the games free for everyone. Your ${t.label} membership runs until ${fmtDay(user.memberUntil)}.`,
      button: { label: "See your membership", url: `${env.clientUrl}/membership` },
      note: "Nothing renews by itself — we'll remind you a few days before it ends.",
    });
  }
  return claimed;
}

/** Run by the server now and then: a "renew" reminder a few days before a membership ends — once per end date. */
export async function remindMembers(now = Date.now()) {
  const due = await User.find({
    memberUntil: { $gt: new Date(now), $lte: new Date(now + REMIND_DAYS * DAY) },
    memberTier: { $exists: true },
  })
    .select("email name memberTier memberUntil memberRemindedFor")
    .limit(200);
  for (const u of due) {
    if (!u.memberUntil || !u.memberTier || u.memberRemindedFor?.getTime() === u.memberUntil.getTime()) continue;
    // Claim it first, so two servers never both send
    const claimed = await User.updateOne({ _id: u._id, memberRemindedFor: { $ne: u.memberUntil } }, { $set: { memberRemindedFor: u.memberUntil } });
    if (!claimed.modifiedCount) continue;
    const t = TIERS[u.memberTier];
    await email(u.email, `Your DMY ${t.label} membership ends ${fmtDay(u.memberUntil)}`, {
      title: `Your ${t.label} ${t.badge} ends ${fmtDay(u.memberUntil)}`,
      intro: `Hi ${u.name || "Lenko Army"} — your ${t.label} membership ends on ${fmtDay(u.memberUntil)}. Renew to keep your ${t.badge} badge and perks. Thanks for keeping the games free for everyone.`,
      button: { label: `Renew — GH₵${t.priceGhs}`, url: `${env.clientUrl}/membership` },
    });
  }
}
