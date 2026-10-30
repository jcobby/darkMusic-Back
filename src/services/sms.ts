import { env } from "../config/env";

/** Text messages go out through Arkesel (ARKESEL_API_KEY + SMS_SENDER_ID). */
export const isSmsConfigured = () => Boolean(env.sms.arkeselKey) || env.sms.devLog;

// With SMS_DEV_LOG (local testing only): the last message to each number, instead of sending it.
const devOutbox = new Map<string, string>();
export const lastDevSms = (to: string) => devOutbox.get(to) ?? null;

/** Send a text to a Ghana number ("0241234567"). True once Arkesel accepts it. */
export async function sendSms(to: string, message: string): Promise<boolean> {
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
