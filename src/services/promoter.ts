import crypto from "crypto";
import { Types } from "mongoose";
import type { Request } from "express";
import { User } from "../models/User";
import { UserDevice } from "../models/UserDevice";
import { WalletTxn } from "../models/Wallet";
import { Promoter, PromoClick, PromoMonth, PromoSettings, PROMO_DEFAULT_TARGETS, type IPromoter, type LinkKind, type RejectReason } from "../models/Promoter";
import { clientIp } from "../utils/clientIp";
import { normalizeMomo } from "./prizes";

/**
 * The Lenko Army promoter program. Every member's link is darkmusicyard.com/r/<their
 * referral code>; once they verify their phone by SMS, each visitor who clicks it counts
 * once a month (towards REWARD_TIERS), and the link takes them to one of Lenko's videos on YouTube.
 *
 * One person, one account: the same phone number, browser or payout Mobile Money number
 * on two accounts disqualifies every account involved — until DMY checks and clears them.
 */
export const REWARD_TIERS = [
  { clicks: 3000, ghs: 400 },
  { clicks: 1000, ghs: 50 },
] as const;
/** The reward a month's clicks earn: the highest tier reached (not both). */
export const rewardFor = (clicks: number) => REWARD_TIERS.find((t) => clicks >= t.clicks)?.ghs ?? 0;
/** At most this many counted clicks a day from one internet connection (shared mobile networks need a few). */
export const IP_DAILY_CAP = 10;

export const monthOf = (d = new Date()) => d.toISOString().slice(0, 7);
const dayOf = (d = new Date()) => d.toISOString().slice(0, 10);
const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

export async function promoSettings() {
  const s = await PromoSettings.findById("settings").lean();
  return { open: s?.open ?? true, targets: s?.targets?.length ? s.targets : PROMO_DEFAULT_TARGETS };
}

/** Where one visit goes: any of the links, at random, so every video gets its share. */
export const pickTarget = (targets: string[]) => targets[crypto.randomInt(targets.length)];

/** Only YouTube links: the program promotes DMY's channel, and the link can't be turned into an open redirect. */
export function isYoutubeUrl(v: unknown): v is string {
  try {
    const u = new URL(String(v));
    return u.protocol === "https:" && /^(www\.|m\.)?(youtube\.com|youtu\.be)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

// ---------- Browsers (devices) ----------

/** The browser id the site sends (X-DMY-Device), hashed — or null. */
export function deviceOf(req: Request): string | null {
  const raw = req.headers["x-dmy-device"];
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return v && /^[A-Za-z0-9-]{16,64}$/.test(v) ? sha(`dmy-device:${v}`) : null;
}

const seenRecently = new Map<string, number>(); // user:device → last write, so /me doesn't write every time
/** Note the browser a member is using. A new one on a promoter's account re-runs the duplicate check. */
export async function recordDevice(userId: string | Types.ObjectId, req: Request): Promise<void> {
  const device = deviceOf(req);
  if (!device) return;
  const key = `${userId}:${device}`;
  if (Date.now() - (seenRecently.get(key) ?? 0) < 3600e3) return;
  seenRecently.set(key, Date.now());
  if (seenRecently.size > 50_000) seenRecently.clear();
  try {
    const now = new Date();
    const r = await UserDevice.updateOne({ user: userId, device }, { $set: { lastSeenAt: now }, $setOnInsert: { firstSeenAt: now } }, { upsert: true });
    if (!r.upsertedCount) return;
    // A new browser for this account: does it belong to someone else's account too?
    const others = await UserDevice.find({ device, user: { $ne: userId } }).distinct("user");
    if (others.length || (await Promoter.exists({ user: userId }))) await recheck(userId);
    for (const o of others) if (await Promoter.exists({ user: o })) await recheck(o, false);
  } catch (err) {
    console.error("[promoter] couldn't record a device:", err);
  }
}

// ---------- One person, one account ----------

/** "0241234567" → a pattern matching it however it was typed on a profile ("024 123 4567", "+233 24…"). */
const phonePattern = (n: string) => new RegExp(`${n.slice(1).split("").join("\\D*")}\\s*$`);

/** Other accounts that look like this member: same browser, same phone number, same payout MoMo number. */
export async function relatedAccounts(userId: string | Types.ObjectId): Promise<{ kind: LinkKind; other: Types.ObjectId }[]> {
  const id = new Types.ObjectId(String(userId));
  const [user, me, devices] = await Promise.all([
    User.findById(id).select("phone").lean(),
    Promoter.findOne({ user: id }).lean(),
    UserDevice.find({ user: id }).distinct("device"),
  ]);
  const out = new Map<string, { kind: LinkKind; other: Types.ObjectId }>();
  const add = (kind: LinkKind, other: Types.ObjectId | string) => {
    const k = `${kind}:${other}`;
    if (String(other) !== String(id) && !out.has(k)) out.set(k, { kind, other: new Types.ObjectId(String(other)) });
  };

  if (devices.length) for (const o of await UserDevice.find({ device: { $in: devices }, user: { $ne: id } }).distinct("user")) add("device", o);

  const phones = [...new Set([me?.phone, normalizeMomo(user?.phone)].filter((p): p is string => Boolean(p)))];
  for (const p of phones) {
    for (const u of await User.find({ _id: { $ne: id }, phone: phonePattern(p) }).select("phone").lean()) {
      if (normalizeMomo(u.phone) === p) add("phone", u._id);
    }
    for (const o of await Promoter.find({ phone: p, user: { $ne: id } }).select("user").lean()) add("phone", o.user);
  }

  const momo = me?.momo?.number;
  if (momo) {
    for (const o of await Promoter.find({ "momo.number": momo, user: { $ne: id } }).select("user").lean()) add("momo", o.user);
    for (const u of await WalletTxn.find({ kind: "withdrawal", "momo.number": momo, user: { $ne: id } }).distinct("user")) add("momo", u);
  }
  return [...out.values()];
}

const WHY: Record<LinkKind, string> = {
  device: "Another account has been used on the same phone or computer",
  phone: "Another account has the same phone number",
  momo: "Another account uses the same Mobile Money number",
};

/**
 * Re-run the duplicate check for a member: keep their links to other accounts up to date
 * and disqualify them while any link DMY hasn't cleared remains. With `spread`, accounts
 * it finds are re-checked too, so both sides are disqualified.
 */
export async function recheck(userId: string | Types.ObjectId, spread = true): Promise<IPromoter | null> {
  const p = await Promoter.findOne({ user: userId });
  if (!p) return null;
  const found = await relatedAccounts(userId);
  const before = new Map(p.links.map((l) => [`${l.kind}:${l.other}`, l.at]));
  p.links = found.map((l) => ({ ...l, at: before.get(`${l.kind}:${l.other}`) ?? new Date() })) as IPromoter["links"];
  const live = p.links.filter((l) => !p.cleared.some((c) => String(c) === String(l.other)));
  if (!p.manual) {
    p.status = live.length ? "disqualified" : "active";
    p.reason = live.length ? WHY[live[0].kind] : undefined;
  }
  await p.save();
  if (spread) for (const l of live) if (await Promoter.exists({ user: l.other })) await recheck(l.other, false);
  return p;
}

/** Hourly: re-check every member (catches matches that appeared on the other account's side). */
export async function recheckAllPromoters(): Promise<void> {
  for (const p of await Promoter.find().select("user").lean()) await recheck(p.user, false);
}

// ---------- Counting clicks ----------

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp\/|telegrambot|discord|headless|curl|wget|python|axios|node-fetch|go-http|okhttp|java\//i;

/**
 * A visitor opened a member's link. Counts it if: the member has verified their phone,
 * the program is on, it's a real browser, not the member themselves, this browser hasn't
 * counted for them this month, and their connection hasn't hit today's cap.
 */
export async function countClick(req: Request, code: string, visitorId: unknown): Promise<{ counted: boolean; reason?: RejectReason | "inactive" }> {
  const settings = await promoSettings();
  const user = /^[a-f0-9]{6,32}$/i.test(code) ? await User.findOne({ referralCode: code }).select("_id").lean() : null;
  const promoter = user && (await Promoter.exists({ user: user._id }));
  if (!user || !promoter || !settings.open) return { counted: false, reason: "inactive" };

  const month = monthOf();
  const reject = async (reason: RejectReason) => {
    await PromoMonth.updateOne({ user: user._id, month }, { $inc: { [`rejected.${reason}`]: 1 } }, { upsert: true }).catch(() => {});
    return { counted: false, reason };
  };

  if (BOT.test(String(req.headers["user-agent"] || ""))) return reject("bot");
  const vid = typeof visitorId === "string" && /^[A-Za-z0-9-]{16,64}$/.test(visitorId) ? visitorId : null;
  if (!vid) return reject("noid");
  const visitor = sha(`dmy-device:${vid}`); // the same hash as the member's own browsers (deviceOf)
  if (String(req.fan?.id) === String(user._id) || (await UserDevice.exists({ user: user._id, device: visitor }))) return reject("own");

  const day = dayOf();
  const ip = sha(`dmy-ip:${clientIp(req)}`);
  if ((await PromoClick.countDocuments({ promoter: user._id, day, ip })) >= IP_DAILY_CAP) return reject("ip");
  try {
    await PromoClick.create({ promoter: user._id, month, day, visitor, ip, at: new Date() });
  } catch {
    return reject("repeat"); // this browser already counted for them this month
  }
  await PromoMonth.updateOne({ user: user._id, month }, { $inc: { clicks: 1 } }, { upsert: true });
  return { counted: true };
}
