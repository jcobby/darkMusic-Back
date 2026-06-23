"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendNotification = sendNotification;
const nodemailer_1 = __importDefault(require("nodemailer"));
const env_1 = require("../config/env");
let transporter = null;
function getTransporter() {
    if (!(0, env_1.isSmtpConfigured)())
        return null;
    if (!transporter) {
        transporter = nodemailer_1.default.createTransport({
            host: env_1.env.smtp.host,
            port: env_1.env.smtp.port,
            secure: env_1.env.smtp.port === 465,
            auth: { user: env_1.env.smtp.user, pass: env_1.env.smtp.pass },
        });
    }
    return transporter;
}
/**
 * Send a notification email. No-ops (and logs) when SMTP isn't configured so
 * inquiries/orders still succeed without email set up.
 */
async function sendNotification(subject, text) {
    const tx = getTransporter();
    if (!tx) {
        console.log(`[mailer] SMTP not configured — skipping email: "${subject}"`);
        return;
    }
    try {
        await tx.sendMail({
            from: env_1.env.smtp.from,
            to: env_1.env.contactEmail,
            subject,
            text,
        });
    }
    catch (err) {
        console.error("[mailer] failed to send notification:", err);
    }
}
//# sourceMappingURL=mailer.js.map