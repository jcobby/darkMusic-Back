"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Beat = void 0;
const mongoose_1 = require("mongoose");
const beatSchema = new mongoose_1.Schema({
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    coverImage: { type: String, trim: true },
    genre: { type: String, trim: true },
    mp3FreeKey: { type: String, trim: true },
    wavKey: { type: String, trim: true },
    wavPriceGhs: { type: Number, default: 100, min: 0 },
    isFeatured: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
}, { timestamps: true });
exports.Beat = (0, mongoose_1.model)("Beat", beatSchema);
//# sourceMappingURL=Beat.js.map