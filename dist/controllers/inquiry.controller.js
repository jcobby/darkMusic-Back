"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInquiry = createInquiry;
const Inquiry_1 = require("../models/Inquiry");
const mailer_1 = require("../services/mailer");
const isEmail = (v) => typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
/** Public endpoint for the Features / Brand Promotion / Contact forms. */
async function createInquiry(req, res, next) {
    try {
        const body = req.body ?? {};
        const type = body.type;
        if (!Inquiry_1.INQUIRY_TYPES.includes(type)) {
            return res.status(400).json({ message: "Invalid inquiry type" });
        }
        if (!body.name || !isEmail(body.email)) {
            return res.status(400).json({ message: "Name and a valid email are required" });
        }
        const inquiry = await Inquiry_1.Inquiry.create({
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
        void (0, mailer_1.sendNotification)(`New ${type} inquiry from ${inquiry.name}`, JSON.stringify(inquiry.toObject(), null, 2));
        res.status(201).json({ ok: true, id: inquiry._id });
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=inquiry.controller.js.map