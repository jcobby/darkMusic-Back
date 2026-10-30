import "dotenv/config";
import path from "path";

// CLIENT_URL may be a comma-separated list of allowed frontend origins (apex
// domain, www, the Vercel URL…). Trailing slashes are stripped so they match
// the browser's Origin header exactly for CORS.
const clientUrls = (process.env.CLIENT_URL || "http://localhost:3000")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

/**
 * Centralized, typed access to environment variables with sane defaults so the
 * app boots even before every secret is filled in. Payment/admin features that
 * require real credentials degrade gracefully and report clear errors.
 */
export const env = {
  port: Number(process.env.PORT) || 5000,
  clientUrls,
  clientUrl: clientUrls[0], // primary origin — used to build the Paystack return URL
  apiBaseUrl: (process.env.API_BASE_URL || "http://localhost:5000").replace(/\/+$/, ""),
  mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/darkyard",

  // Auth (single admin)
  jwtSecret: process.env.JWT_SECRET || "dev-insecure-secret-change-me",
  adminEmail: (process.env.ADMIN_EMAIL || "lenkogh.music@gmail.com").toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || "darkyard-admin",

  // Paystack
  paystackSecret: process.env.PAYSTACK_SECRET_KEY || "",
  paystackPublic: process.env.PAYSTACK_PUBLIC_KEY || "",
  currency: process.env.CURRENCY || "GHS",

  // Cloudinary (media storage + delivery)
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || "",
    apiKey: process.env.CLOUDINARY_API_KEY || "",
    apiSecret: process.env.CLOUDINARY_API_SECRET || "",
  },

  // Contact / notifications
  whatsappNumber: process.env.WHATSAPP_NUMBER || "",
  contactEmail: process.env.CONTACT_EMAIL || "info@darkmusicyard.com",

  // Optional SMTP (nodemailer) — if unset, notifications are skipped silently
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || process.env.SMTP_USER || "",
  },
  // Resend (resend.com) — when set, all email goes through its HTTPS API instead
  // of ZeptoMail/SMTP. Sends from EMAIL_FROM (or SMTP_FROM) on a domain verified in Resend.
  resendApiKey: process.env.RESEND_API_KEY || "",
  emailFrom: process.env.EMAIL_FROM || process.env.SMTP_FROM || "Dark Music Yard <noreply@darkmusicyard.com>",
  // EmailJS (emailjs.com) — sends through a connected mailbox (e.g. Gmail), no DNS
  // needed. Its template must use {{to_email}}, {{subject}} and {{{html}}}.
  emailjs: {
    serviceId: process.env.EMAILJS_SERVICE_ID || "",
    templateId: process.env.EMAILJS_TEMPLATE_ID || "",
    publicKey: process.env.EMAILJS_PUBLIC_KEY || "",
    privateKey: process.env.EMAILJS_PRIVATE_KEY || "",
  },

  // SMS (phone codes for the Lenko Army promoter program) through Arkesel (arkesel.com).
  // SMS_SENDER_ID must be a sender ID approved on Arkesel (11 characters at most).
  // SMS_DEV_LOG=1 prints messages to the console instead of sending — local testing only.
  sms: {
    arkeselKey: process.env.ARKESEL_API_KEY || "",
    senderId: (process.env.SMS_SENDER_ID || "DMY").slice(0, 11),
    devLog: process.env.SMS_DEV_LOG === "1",
  },

  // Beat Breaker: the first month whose board adds up daily bests (YYYY-MM; see services/gameScoring)
  gameDailyFrom: /^\d{4}-\d{2}$/.test(process.env.GAME_DAILY_FROM || "") ? process.env.GAME_DAILY_FROM! : "2026-11",

  // Local file storage roots (gitignored)
  storageDir: path.resolve(process.cwd(), "storage"),
  downloadTokenTtlHours: 48,
  downloadMaxUses: 5,
} as const;

export const isPaystackConfigured = () => Boolean(env.paystackSecret);
export const isSmtpConfigured = () => Boolean(env.smtp.host && env.smtp.user);
export const isEmailJsConfigured = () =>
  Boolean(env.emailjs.serviceId && env.emailjs.templateId && env.emailjs.publicKey && env.emailjs.privateKey);
/** Some way of sending email is set up (Resend, EmailJS, ZeptoMail or SMTP). */
export const isEmailConfigured = () => Boolean(env.resendApiKey) || isEmailJsConfigured() || isSmtpConfigured();
export const isCloudinaryConfigured = () =>
  Boolean(env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret);
