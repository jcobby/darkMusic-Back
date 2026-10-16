import crypto from "crypto";
import { env, isPaystackConfigured } from "../config/env";

const BASE = "https://api.paystack.co";

function authHeaders() {
  return {
    Authorization: `Bearer ${env.paystackSecret}`,
    "Content-Type": "application/json",
  };
}

export interface InitializeArgs {
  email: string;
  amountGhs: number;
  reference: string;
  callbackUrl: string;
  metadata?: Record<string, unknown>;
}

export interface InitializeResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

/** Create a Paystack transaction and return the hosted-checkout URL. */
export async function initializeTransaction(
  args: InitializeArgs
): Promise<InitializeResult> {
  if (!isPaystackConfigured()) {
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
      currency: env.currency,
      reference: args.reference,
      callback_url: args.callbackUrl,
      channels: ["card", "mobile_money", "bank_transfer"],
      metadata: args.metadata ?? {},
    }),
  });
  const json = (await res.json()) as any;
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

export interface VerifyResult {
  paid: boolean;
  reference: string;
  amountGhs: number;
  raw: any;
}

/** Confirm a transaction's final status with Paystack. */
export async function verifyTransaction(reference: string): Promise<VerifyResult> {
  if (!isPaystackConfigured()) {
    throw Object.assign(new Error("Payments are not configured yet"), {
      statusCode: 503,
    });
  }
  const res = await fetch(`${BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: authHeaders(),
  });
  const json = (await res.json()) as any;
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

// ---------- Transfers (paying prize winners to Mobile Money) ----------
// Needs Transfers switched on for the Paystack business. If "OTP for transfers"
// is on in Paystack's settings, a transfer waits for the code Paystack sends the
// owner (finalizeTransfer).

async function paystackCall(path: string, body: Record<string, unknown>): Promise<any> {
  if (!isPaystackConfigured()) {
    throw Object.assign(new Error("Payments are not configured yet"), { statusCode: 503 });
  }
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !json.status) {
    throw Object.assign(new Error(json.message || `Paystack ${path} failed`), { statusCode: 502 });
  }
  return json.data;
}

/** A Mobile Money recipient for transfers; returns Paystack's recipient code. */
export async function createTransferRecipient(args: { name: string; accountNumber: string; bankCode: string }): Promise<string> {
  const data = await paystackCall("/transferrecipient", {
    type: "mobile_money",
    name: args.name,
    account_number: args.accountNumber,
    bank_code: args.bankCode,
    currency: env.currency,
  });
  return data.recipient_code;
}

/** Send money from the Paystack balance. status: "success" | "pending" | "otp" | "failed" | … */
export async function initiateTransfer(args: {
  amountGhs: number;
  recipientCode: string;
  reference: string;
  reason: string;
}): Promise<{ status: string; transferCode: string }> {
  const data = await paystackCall("/transfer", {
    source: "balance",
    amount: Math.round(args.amountGhs * 100), // pesewas
    currency: env.currency,
    recipient: args.recipientCode,
    reference: args.reference,
    reason: args.reason,
  });
  return { status: String(data.status), transferCode: String(data.transfer_code) };
}

/** Complete a transfer that's waiting for the owner's OTP. */
export async function finalizeTransfer(transferCode: string, otp: string): Promise<{ status: string }> {
  const data = await paystackCall("/transfer/finalize_transfer", { transfer_code: transferCode, otp });
  return { status: String(data?.status ?? "pending") };
}

/** Validate the x-paystack-signature header against the raw request body. */
export function verifyWebhookSignature(rawBody: Buffer, signature?: string): boolean {
  if (!signature || !env.paystackSecret) return false;
  const hash = crypto
    .createHmac("sha512", env.paystackSecret)
    .update(rawBody)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
  } catch {
    return false;
  }
}
