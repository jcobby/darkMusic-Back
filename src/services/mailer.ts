import nodemailer from "nodemailer";
import { env, isSmtpConfigured } from "../config/env";

let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (!isSmtpConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.port === 465,
      auth: { user: env.smtp.user, pass: env.smtp.pass },
    });
  }
  return transporter;
}

/**
 * Send a notification email. No-ops (and logs) when SMTP isn't configured so
 * inquiries/orders still succeed without email set up.
 */
export async function sendNotification(subject: string, text: string): Promise<void> {
  const tx = getTransporter();
  if (!tx) {
    console.log(`[mailer] SMTP not configured — skipping email: "${subject}"`);
    return;
  }
  try {
    await tx.sendMail({
      from: env.smtp.from,
      to: env.contactEmail,
      subject,
      text,
    });
  } catch (err) {
    console.error("[mailer] failed to send notification:", err);
  }
}
