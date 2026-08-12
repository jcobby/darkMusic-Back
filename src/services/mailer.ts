import nodemailer from "nodemailer";
import { env, isSmtpConfigured } from "../config/env";

/**
 * Email delivery. Prefers ZeptoMail's HTTPS API (port 443) because many hosts
 * — including Render's free tier — block outbound SMTP ports (25/465/587), so
 * nodemailer SMTP times out there. Falls back to SMTP for other providers.
 */

// ZeptoMail is detected from the configured host (smtp.zeptomail.com, .eu, …).
const isZepto = /zeptomail/i.test(env.smtp.host);
// smtp.zeptomail.com → https://api.zeptomail.com/v1.1/email (works for any region).
const zeptoApiUrl = `https://${env.smtp.host.replace(/^smtp\./i, "api.")}/v1.1/email`;

/** Split "Name <email@x.com>" into its parts (or treat the whole thing as the address). */
function parseFrom(from: string): { address: string; name: string } {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].replace(/^"|"$/g, "").trim(), address: m[2].trim() };
  return { name: "", address: from.trim() };
}

async function sendViaZeptoApi(to: string, subject: string, text: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const { address, name } = parseFrom(env.smtp.from);
    const key = env.smtp.pass.startsWith("Zoho-enczapikey")
      ? env.smtp.pass
      : `Zoho-enczapikey ${env.smtp.pass}`;
    const res = await fetch(zeptoApiUrl, {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        from: { address, name },
        to: [{ email_address: { address: to } }],
        subject,
        textbody: text,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[mailer] ZeptoMail API ${res.status}: ${body.slice(0, 500)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[mailer] ZeptoMail API request failed:", err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---- SMTP fallback (non-ZeptoMail providers, or hosts that allow SMTP) ----
let transporter: nodemailer.Transporter | null = null;
function getTransporter() {
  if (!isSmtpConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.port === 465,
      auth: { user: env.smtp.user, pass: env.smtp.pass },
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  return transporter;
}

/**
 * Send an email to a specific recipient. Returns whether it was actually sent
 * (false when email isn't configured, so callers can respond accordingly).
 */
export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  if (isZepto) return sendViaZeptoApi(to, subject, text);
  const tx = getTransporter();
  if (!tx) {
    console.log(`[mailer] not configured — skipping email to ${to}: "${subject}"`);
    return false;
  }
  try {
    await tx.sendMail({ from: env.smtp.from, to, subject, text });
    return true;
  } catch (err) {
    console.error("[mailer] SMTP send failed:", err);
    return false;
  }
}

/** Send an internal notification to the site's contact address. */
export async function sendNotification(subject: string, text: string): Promise<void> {
  await sendMail(env.contactEmail, subject, text);
}
