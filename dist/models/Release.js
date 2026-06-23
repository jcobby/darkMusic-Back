"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Release = void 0;
const mongoose_1 = require("mongoose");
const releaseSchema = new mongoose_1.Schema({
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    coverImage: { type: String, trim: true },
    spotifyUrl: { type: String, trim: true },
    appleUrl: { type: String, trim: true },
    youtubeUrl: { type: String, trim: true },
    isFeatured: { type: Boolean, default: false },
    downloadable: { type: Boolean, default: false },
    priceGhs: { type: Number, default: 10, min: 0 },
    audioKey: { type: String, trim: true },
    order: { type: Number, default: 0 },
}, { timestamps: true });
exports.Release = (0, mongoose_1.model)("Release", releaseSchema);
//# sourceMappingURL=Release.js.map