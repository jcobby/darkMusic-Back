import type { Types } from "mongoose";
import { env } from "../config/env";
import { User } from "../models/User";
import { Promoter } from "../models/Promoter";
import { normalizeMomo } from "../utils/phone";

/** Text messages go out through Arkesel (ARKESEL_API_KEY + SMS_SENDER_ID). */
export const isSmsConfigured = () => Boolean(env.sms.arkeselKey) || env.sms.devLog;

// With SMS_DEV_LOG (local testing only): the last message to each number, instead of sending it.
const devOutbox = new Map<string, string>();
export const lastDevSms = (to: string) => devOutbox.get(to) ?? null;

/**
 * Plain characters only: one symbol outside the basic SMS alphabet (₵, curly quotes, •, emoji)
 * switches the whole text to Unicode — 70 characters a part instead of 160, so 2–3 credits.
 */
const plain = (s: string) =>
  s
    .replace(/GH₵\s?/g, "GHS ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/•/g, "*");

/** GH₵1,000 as texts write it: "GHS 1,000". */
export const smsGhs = (n: number) => `GHS ${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
/** The site's address without https:// — shorter in a text ("darkmusicyard.com"). */
export const siteHost = () => env.clientUrl.replace(/^https?:\/\//, "");

/** Send a text to a Ghana number ("0241234567"). True once Arkesel accepts it. */
export async function sendSms(to: string, message: string): Promise<boolean> {
  message = plain(message);
  if (!env.sms.arkeselKey) {
    if (!env.sms.devLog) return false;
    devOutbox.set(to, message);
    console.log(`[sms:dev] ${to}: ${message}`);
    return true;
  }
  try {
    const res = await fetch("https://sms.arkesel.com/api/v2/sms/send", {
      method: "POST",
      headers: { "api-key": env.sms.arkeselKey, "Content-Type": "application/json" },
      body: JSON.stringify({ sender: env.sms.senderId, message, recipients: [`233${to.slice(1)}`] }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as { status?: string; message?: string } | null;
    if (!res.ok || body?.status !== "success") {
      console.error(`[sms] Arkesel didn't send it (${res.status}): ${body?.message ?? "no reason given"}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[sms] send failed:", err);
    return false;
  }
}

/**
 * Text a member about their own prize or payout — to the number they confirmed by code
 * (promoters), else the one on their profile, else `fallback` (e.g. the Mobile Money number
 * the money went to). Quietly does nothing without a number. True if a text went out.
 */
export async function textMember(userId: string | Types.ObjectId, message: string, fallback?: string | null): Promise<boolean> {
  try {
    const [p, u] = await Promise.all([
      Promoter.findOne({ user: userId }).select("phone").lean(),
      User.findById(userId).select("phone").lean(),
    ]);
    const to = p?.phone ?? normalizeMomo(u?.phone) ?? normalizeMomo(fallback);
    return to ? await sendSms(to, message) : false;
  } catch (err) {
    console.error("[sms] couldn't text a member:", err);
    return false;
  }
}
