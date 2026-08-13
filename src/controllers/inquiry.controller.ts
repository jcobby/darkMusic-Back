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
      [
        `Type: ${type}`,
        `Name: ${inquiry.name}`,
        `Email: ${inquiry.email}`,
        inquiry.phone ? `Phone: ${inquiry.phone}` : "",
        inquiry.artistName ? `Artist: ${inquiry.artistName}` : "",
        inquiry.songLink ? `Song: ${inquiry.songLink}` : "",
        inquiry.businessName ? `Business: ${inquiry.businessName}` : "",
        inquiry.service ? `Service: ${inquiry.service}` : "",
        inquiry.budget ? `Budget: ${inquiry.budget}` : "",
        inquiry.deadline ? `Deadline: ${inquiry.deadline}` : "",
        inquiry.message ? `Message: ${inquiry.message}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );

    res.status(201).json({ ok: true, id: inquiry._id });
  } catch (err) {
    next(err);
  }
}
