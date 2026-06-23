"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Order = void 0;
const mongoose_1 = require("mongoose");
const orderItemSchema = new mongoose_1.Schema({
    kind: {
        type: String,
        enum: ["release_mp3", "beat_wav", "merch"],
        required: true,
    },
    refId: { type: String, required: true },
    name: { type: String, required: true },
    amountGhs: { type: Number, required: true, min: 0 },
    qty: { type: Number, default: 1, min: 1 },
    size: { type: String },
}, { _id: false });
const downloadTokenSchema = new mongoose_1.Schema({
    token: { type: String, required: true, index: true },
    kind: { type: String, enum: ["release_mp3", "beat_wav", "merch"], required: true },
    refId: { type: String, required: true },
    fileKey: { type: String, required: true },
    name: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    uses: { type: Number, default: 0 },
    maxUses: { type: Number, default: 5 },
}, { _id: false });
const orderSchema = new mongoose_1.Schema({
    reference: { type: String, required: true, unique: true, index: true },
    customerEmail: { type: String, required: true, trim: true, lowercase: true },
    customerName: { type: String, trim: true },
    items: { type: [orderItemSchema], default: [] },
    totalGhs: { type: Number, required: true, min: 0 },
    status: {
        type: String,
        enum: ["pending", "paid", "failed"],
        default: "pending",
        index: true,
    },
    paystackRef: { type: String, trim: true },
    downloadTokens: { type: [downloadTokenSchema], default: [] },
}, { timestamps: true });
exports.Order = (0, mongoose_1.model)("Order", orderSchema);
//# sourceMappingURL=Order.js.map