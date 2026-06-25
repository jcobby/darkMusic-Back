import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { env } from "../config/env";
import { Order, IOrder, IOrderItem, IDownloadToken, OrderItemKind } from "../models/Order";
import { Release } from "../models/Release";
import { Beat } from "../models/Beat";
import { MerchProduct } from "../models/MerchProduct";
import {
  initializeTransaction,
  verifyTransaction,
  verifyWebhookSignature,
} from "../services/paystack";
import { downloadUrl } from "../services/cloudinary";
import { sendNotification } from "../services/mailer";

interface CartLine {
  kind: OrderItemKind;
  refId: string;
  qty?: number;
  size?: string;
}

const isEmail = (v: unknown) => typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

/** Resolve a cart line against the DB, returning a priced order item + file key. */
async function priceLine(
  line: CartLine
): Promise<{ item: IOrderItem; fileKey?: string }> {
  const qty = Math.max(1, Math.floor(Number(line.qty) || 1));

  if (line.kind === "release_mp3") {
    const r = await Release.findById(line.refId);
    if (!r || r.hidden || !r.downloadable || !r.audioKey) {
      throw Object.assign(new Error("Release not available for download"), {
        statusCode: 400,
      });
    }
    return {
      item: { kind: "release_mp3", refId: String(r._id), name: r.title, amountGhs: r.priceGhs, qty: 1 },
      fileKey: r.audioKey,
    };
  }

  if (line.kind === "beat_wav") {
    const b = await Beat.findById(line.refId);
    if (!b || b.hidden || !b.wavKey) {
      throw Object.assign(new Error("Beat WAV not available"), { statusCode: 400 });
    }
    return {
      item: { kind: "beat_wav", refId: String(b._id), name: `${b.title} (WAV)`, amountGhs: b.wavPriceGhs, qty: 1 },
      fileKey: b.wavKey,
    };
  }

  // merch
  const m = await MerchProduct.findById(line.refId);
  if (!m || m.hidden) throw Object.assign(new Error("Product not found"), { statusCode: 400 });
  if (m.stock < qty) {
    throw Object.assign(new Error(`Only ${m.stock} of ${m.name} in stock`), {
      statusCode: 400,
    });
  }
  return {
    item: { kind: "merch", refId: String(m._id), name: m.name, amountGhs: m.priceGhs, qty, size: line.size },
  };
}

/** POST /api/checkout/initialize */
export async function initialize(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, name, items } = req.body ?? {};
    if (!isEmail(email)) {
      return res.status(400).json({ message: "A valid email is required" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Cart is empty" });
    }

    const priced = await Promise.all((items as CartLine[]).map(priceLine));
    const orderItems = priced.map((p) => p.item);
    const totalGhs = orderItems.reduce((sum, it) => sum + it.amountGhs * it.qty, 0);
    if (totalGhs <= 0) {
      return res.status(400).json({ message: "Order total must be greater than zero" });
    }

    const reference = `DMY-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

    await Order.create({
      reference,
      customerEmail: email,
      customerName: name,
      items: orderItems,
      totalGhs,
      status: "pending",
    });

    const init = await initializeTransaction({
      email,
      amountGhs: totalGhs,
      reference,
      callbackUrl: `${env.clientUrl}/checkout/callback`,
      metadata: { reference },
    });

    res.json({
      authorizationUrl: init.authorizationUrl,
      reference,
      totalGhs,
      publicKey: env.paystackPublic,
    });
  } catch (err) {
    next(err);
  }
}

/** Resolve a stored file key for a digital line item. */
async function fileKeyFor(item: IOrderItem): Promise<string | undefined> {
  if (item.kind === "release_mp3") {
    const r = await Release.findById(item.refId);
    return r?.audioKey;
  }
  if (item.kind === "beat_wav") {
    const b = await Beat.findById(item.refId);
    return b?.wavKey;
  }
  return undefined;
}

/**
 * Mark an order paid and mint download tokens / decrement stock — exactly once.
 * Uses an atomic conditional update to "claim" the order so concurrent callers
 * (verify-on-return AND the Paystack webhook) can't both run the side effects.
 */
async function fulfillOrder(orderId: string, paystackRef?: string): Promise<IOrder | null> {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, status: { $ne: "paid" } },
    { $set: { status: "paid", ...(paystackRef ? { paystackRef } : {}) } },
    { new: true }
  );
  // Lost the race (another path already fulfilled) — return the paid order as-is.
  if (!order) return Order.findById(orderId);

  const tokens: IDownloadToken[] = [];
  const oversold: string[] = [];
  for (const item of order.items) {
    if (item.kind === "merch") {
      // Atomic conditional decrement — only succeeds if enough stock remains,
      // so concurrent orders can never push stock negative (no oversell).
      const updated = await MerchProduct.findOneAndUpdate(
        { _id: item.refId, stock: { $gte: item.qty } },
        { $inc: { stock: -item.qty } },
        { new: true }
      );
      if (!updated) oversold.push(`${item.name} x${item.qty}${item.size ? ` (${item.size})` : ""}`);
      continue;
    }
    const fileKey = await fileKeyFor(item);
    if (!fileKey) continue;
    tokens.push({
      token: crypto.randomBytes(24).toString("hex"),
      kind: item.kind,
      refId: item.refId,
      fileKey,
      name: item.name,
      expiresAt: new Date(Date.now() + env.downloadTokenTtlHours * 3600 * 1000),
      uses: 0,
      maxUses: env.downloadMaxUses,
    });
  }

  order.downloadTokens = tokens;
  await order.save();

  void sendNotification(
    `Paid order ${order.reference} — GH₵${order.totalGhs}`,
    `Customer: ${order.customerEmail}\nItems:\n` +
      order.items.map((i) => ` - ${i.name} x${i.qty} = GH₵${i.amountGhs * i.qty}`).join("\n")
  );

  // The customer already paid, so the order stays valid — but flag any item that
  // sold out in the race so it can be restocked or refunded.
  if (oversold.length) {
    void sendNotification(
      `⚠️ Oversold on order ${order.reference} — action needed`,
      `These paid items are out of stock. Restock or refund:\n - ${oversold.join("\n - ")}` +
        `\n\nCustomer: ${order.customerEmail}`
    );
  }

  return order;
}

function orderPublic(order: IOrder) {
  return {
    reference: order.reference,
    status: order.status,
    totalGhs: order.totalGhs,
    items: order.items.map((i) => ({ name: i.name, qty: i.qty, amountGhs: i.amountGhs, kind: i.kind })),
    downloads: order.downloadTokens.map((t) => ({
      name: t.name,
      url: `${env.apiBaseUrl}/api/download/${t.token}`,
      expiresAt: t.expiresAt,
    })),
  };
}

/** GET /api/checkout/verify?reference= */
export async function verify(req: Request, res: Response, next: NextFunction) {
  try {
    const reference = String(req.query.reference || "");
    const existing = await Order.findOne({ reference });
    if (!existing) return res.status(404).json({ message: "Order not found" });

    let order: IOrder = existing;
    if (existing.status !== "paid") {
      const result = await verifyTransaction(reference);
      if (result.paid) {
        order = (await fulfillOrder(String(existing._id), result.reference)) ?? existing;
      } else {
        // Only mark failed if still pending — don't clobber a concurrent webhook.
        await Order.updateOne(
          { _id: existing._id, status: "pending" },
          { $set: { status: "failed" } }
        );
        order = (await Order.findById(existing._id)) ?? existing;
      }
    }
    res.json(orderPublic(order));
  } catch (err) {
    next(err);
  }
}

/** POST /api/checkout/paystack/webhook (raw body) */
export async function webhook(req: Request, res: Response) {
  const signature = req.headers["x-paystack-signature"] as string | undefined;
  if (!req.rawBody || !verifyWebhookSignature(req.rawBody, signature)) {
    return res.status(401).send("invalid signature");
  }
  // Acknowledge fast; process asynchronously.
  res.sendStatus(200);
  try {
    const event = JSON.parse(req.rawBody.toString("utf8"));
    if (event?.event === "charge.success") {
      const reference = event.data?.reference;
      const order = await Order.findOne({ reference });
      // fulfillOrder claims atomically, so it's safe even if verify ran too.
      if (order) await fulfillOrder(String(order._id), reference);
    }
  } catch (err) {
    console.error("[webhook] processing error:", err);
  }
}

/** GET /api/download/:token — streams a purchased digital file. */
export async function download(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.params.token;
    const order = await Order.findOne({ "downloadTokens.token": token });
    if (!order) return res.status(404).json({ message: "Invalid download link" });

    const dl = order.downloadTokens.find((t) => t.token === token)!;
    if (order.status !== "paid") {
      return res.status(403).json({ message: "Order is not paid" });
    }
    if (dl.expiresAt.getTime() < Date.now()) {
      return res.status(410).json({ message: "Download link has expired" });
    }
    if (dl.uses >= dl.maxUses) {
      return res.status(429).json({ message: "Download limit reached" });
    }

    dl.uses += 1;
    await order.save();

    // Hand off to a signed, download-forcing Cloudinary URL for the full file.
    res.redirect(downloadUrl(dl.fileKey));
  } catch (err) {
    next(err);
  }
}
