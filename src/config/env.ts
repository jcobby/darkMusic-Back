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
  contactEmail: process.env.CONTACT_EMAIL || "lenkogh.music@gmail.com",

  // Optional SMTP (nodemailer) — if unset, notifications are skipped silently
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || process.env.SMTP_USER || "",
  },

  // Local file storage roots (gitignored)
  storageDir: path.resolve(process.cwd(), "storage"),
  downloadTokenTtlHours: 48,
  downloadMaxUses: 5,
} as const;

export const isPaystackConfigured = () => Boolean(env.paystackSecret);
export const isSmtpConfigured = () => Boolean(env.smtp.host && env.smtp.user);
export const isCloudinaryConfigured = () =>
  Boolean(env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret);
