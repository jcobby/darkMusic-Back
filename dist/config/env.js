"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSmtpConfigured = exports.isPaystackConfigured = exports.env = void 0;
require("dotenv/config");
const path_1 = __importDefault(require("path"));
/**
 * Centralized, typed access to environment variables with sane defaults so the
 * app boots even before every secret is filled in. Payment/admin features that
 * require real credentials degrade gracefully and report clear errors.
 */
exports.env = {
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
    storageDir: path_1.default.resolve(process.cwd(), "storage"),
    downloadTokenTtlHours: 48,
    downloadMaxUses: 5,
};
const isPaystackConfigured = () => Boolean(exports.env.paystackSecret);
exports.isPaystackConfigured = isPaystackConfigured;
const isSmtpConfigured = () => Boolean(exports.env.smtp.host && exports.env.smtp.user);
exports.isSmtpConfigured = isSmtpConfigured;
//# sourceMappingURL=env.js.map