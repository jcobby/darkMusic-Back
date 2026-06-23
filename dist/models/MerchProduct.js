"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MerchProduct = exports.MERCH_CATEGORIES = void 0;
const mongoose_1 = require("mongoose");
exports.MERCH_CATEGORIES = [
    "tshirt",
    "hoodie",
    "cap",
    "poster",
    "signed",
    "limited",
];
const merchSchema = new mongoose_1.Schema({
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    description: { type: String, trim: true },
    images: { type: [String], default: [] },
    category: { type: String, enum: exports.MERCH_CATEGORIES, required: true },
    priceGhs: { type: Number, required: true, min: 0 },
    sizes: { type: [String], default: [] },
    stock: { type: Number, default: 0, min: 0 },
    isLimited: { type: Boolean, default: false },
    isSigned: { type: Boolean, default: false },
    isFeatured: { type: Boolean, default: false },
}, { timestamps: true });
exports.MerchProduct = (0, mongoose_1.model)("MerchProduct", merchSchema);
//# sourceMappingURL=MerchProduct.js.map