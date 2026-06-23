"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Inquiry = exports.INQUIRY_TYPES = void 0;
const mongoose_1 = require("mongoose");
exports.INQUIRY_TYPES = ["feature", "brand", "contact"];
const inquirySchema = new mongoose_1.Schema({
    type: { type: String, enum: exports.INQUIRY_TYPES, required: true, index: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    artistName: { type: String, trim: true },
    songLink: { type: String, trim: true },
    budget: { type: String, trim: true },
    deadline: { type: String, trim: true },
    businessName: { type: String, trim: true },
    service: { type: String, trim: true },
    message: { type: String, trim: true },
    status: { type: String, enum: ["new", "read", "archived"], default: "new" },
}, { timestamps: true });
exports.Inquiry = (0, mongoose_1.model)("Inquiry", inquirySchema);
//# sourceMappingURL=Inquiry.js.map