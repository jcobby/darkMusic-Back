import { Request, Response, NextFunction } from "express";
import { Inquiry, INQUIRY_TYPES, InquiryType } from "../models/Inquiry";
import { sendNotification } from "../services/mailer";

const isEmail = (v: unknown) => typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

/** Public endpoint for the Features / Brand Promotion / Contact forms. */
export async function createInquiry(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body ?? {};
    const type = body.type as InquiryType;
    if (!INQUIRY_TYPES.includes(type)) {
      return res.status(400).json({ message: "Invalid inquiry type" });
    }
    if (!body.name || !isEmail(body.email)) {
      return res.status(400).json({ message: "Name and a valid email are required" });
    }

    const inquiry = await Inquiry.create({
      type,
      name: body.name,
      email: body.email,
      phone: body.phone,
      artistName: body.artistName,
      songLink: body.songLink,
      budget: body.budget,
      deadline: body.deadline,
      businessName: body.businessName,
      service: body.service,
      message: body.message,
    });

    // Fire-and-forget notification (no-op if SMTP unset).
    void sendNotification(
      `New ${type} inquiry from ${inquiry.name}`,
      JSON.stringify(inquiry.toObject(), null, 2)
    );

    res.status(201).json({ ok: true, id: inquiry._id });
  } catch (err) {
    next(err);
  }
}
