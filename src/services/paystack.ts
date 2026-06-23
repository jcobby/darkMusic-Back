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
