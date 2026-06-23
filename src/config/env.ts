import "dotenv/config";
import path from "path";

/**
 * Centralized, typed access to environment variables with sane defaults so the
 * app boots even before every secret is filled in. Payment/admin features that
 * require real credentials degrade gracefully and report clear errors.
 */
export const env = {
  port: Number(process.env.PORT) || 5000,
  clientUrl: process.env.CLIENT_URL || "http://localhost:3000",
  apiBaseUrl: process.env.API_BASE_URL || "http://localhost:5000",
  mongoUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/darkyard",

  // Auth (single admin)
  jwtSecret: process.env.JWT_SECRET || "dev-insecure-secret-change-me",
  adminEmail: (process.env.ADMIN_EMAIL || "lenkogh.music@gmail.com").toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || "darkyard-admin",

  // Paystack
  paystackSecret: process.env.PAYSTACK_SECRET_KEY || "",
  paystackPublic: process.env.PAYSTACK_PUBLIC_KEY || "",
  currency: process.env.CURRENCY || "GHS",

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
