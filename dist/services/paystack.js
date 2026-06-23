"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeTransaction = initializeTransaction;
exports.verifyTransaction = verifyTransaction;
exports.verifyWebhookSignature = verifyWebhookSignature;
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../config/env");
const BASE = "https://api.paystack.co";
function authHeaders() {
    return {
        Authorization: `Bearer ${env_1.env.paystackSecret}`,
        "Content-Type": "application/json",
    };
}
/** Create a Paystack transaction and return the hosted-checkout URL. */
async function initializeTransaction(args) {
    if (!(0, env_1.isPaystackConfigured)()) {
        throw Object.assign(new Error("Payments are not configured yet"), {
            statusCode: 503,
        });
    }
    const res = await fetch(`${BASE}/transaction/initialize`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
            email: args.email,
            amount: Math.round(args.amountGhs * 100), // pesewas
            currency: env_1.env.currency,
            reference: args.reference,
            callback_url: args.callbackUrl,
            channels: ["card", "mobile_money", "bank_transfer"],
            metadata: args.metadata ?? {},
        }),
    });
    const json = (await res.json());
    if (!res.ok || !json.status) {
        throw Object.assign(new Error(json.message || "Paystack initialize failed"), {
            statusCode: 502,
        });
    }
    return {
        authorizationUrl: json.data.authorization_url,
        accessCode: json.data.access_code,
        reference: json.data.reference,
    };
}
/** Confirm a transaction's final status with Paystack. */
async function verifyTransaction(reference) {
    if (!(0, env_1.isPaystackConfigured)()) {
        throw Object.assign(new Error("Payments are not configured yet"), {
            statusCode: 503,
        });
    }
    const res = await fetch(`${BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: authHeaders(),
    });
    const json = (await res.json());
    if (!res.ok || !json.status) {
        throw Object.assign(new Error(json.message || "Paystack verify failed"), {
            statusCode: 502,
        });
    }
    return {
        paid: json.data.status === "success",
        reference: json.data.reference,
        amountGhs: (json.data.amount ?? 0) / 100,
        raw: json.data,
    };
}
/** Validate the x-paystack-signature header against the raw request body. */
function verifyWebhookSignature(rawBody, signature) {
    if (!signature || !env_1.env.paystackSecret)
        return false;
    const hash = crypto_1.default
        .createHmac("sha512", env_1.env.paystackSecret)
        .update(rawBody)
        .digest("hex");
    try {
        return crypto_1.default.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=paystack.js.map