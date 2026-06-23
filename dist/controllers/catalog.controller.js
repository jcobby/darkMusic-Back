"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listReleases = listReleases;
exports.getRelease = getRelease;
exports.previewRelease = previewRelease;
exports.listBeats = listBeats;
exports.getBeat = getBeat;
exports.downloadFreeBeat = downloadFreeBeat;
exports.listMerch = listMerch;
exports.getMerch = getMerch;
const fs_1 = __importDefault(require("fs"));
const Release_1 = require("../models/Release");
const Beat_1 = require("../models/Beat");
const MerchProduct_1 = require("../models/MerchProduct");
const serialize_1 = require("../utils/serialize");
const storage_1 = require("../services/storage");
// ~30–60s of audio (byte cap; exact length is bitrate-dependent). Enough for a
// taste, never the full song — so paid tracks stay protected while fans preview.
const PREVIEW_BYTES = 1_300_000;
// ----- Releases -----
async function listReleases(req, res, next) {
    try {
        const filter = req.query.featured === "true" ? { isFeatured: true } : {};
        const releases = await Release_1.Release.find(filter).sort({ order: 1, createdAt: -1 });
        res.json(releases.map(serialize_1.publicRelease));
    }
    catch (err) {
        next(err);
    }
}
async function getRelease(req, res, next) {
    try {
        const release = await Release_1.Release.findOne({ slug: req.params.slug });
        if (!release)
            return res.status(404).json({ message: "Release not found" });
        res.json((0, serialize_1.publicRelease)(release));
    }
    catch (err) {
        next(err);
    }
}
/** Streams a capped (~30s) preview of a release's MP3 — never the full file. */
async function previewRelease(req, res, next) {
    try {
        const release = await Release_1.Release.findOne({ slug: req.params.slug });
        if (!release || !release.audioKey || !(0, storage_1.storedFileExists)("audio", release.audioKey)) {
            return res.status(404).json({ message: "Preview not available" });
        }
        const filePath = (0, storage_1.resolveStored)("audio", release.audioKey);
        const size = fs_1.default.statSync(filePath).size;
        if (size <= 0)
            return res.status(404).json({ message: "Preview not available" });
        const end = Math.min(PREVIEW_BYTES, size) - 1;
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Content-Length", String(end + 1));
        res.setHeader("Cache-Control", "public, max-age=3600");
        fs_1.default.createReadStream(filePath, { start: 0, end }).pipe(res);
    }
    catch (err) {
        next(err);
    }
}
// ----- Beats -----
async function listBeats(req, res, next) {
    try {
        const filter = req.query.featured === "true" ? { isFeatured: true } : {};
        const beats = await Beat_1.Beat.find(filter).sort({ order: 1, createdAt: -1 });
        res.json(beats.map(serialize_1.publicBeat));
    }
    catch (err) {
        next(err);
    }
}
async function getBeat(req, res, next) {
    try {
        const beat = await Beat_1.Beat.findOne({ slug: req.params.slug });
        if (!beat)
            return res.status(404).json({ message: "Beat not found" });
        res.json((0, serialize_1.publicBeat)(beat));
    }
    catch (err) {
        next(err);
    }
}
/** Free MP3 download for a beat — no payment required. */
async function downloadFreeBeat(req, res, next) {
    try {
        const beat = await Beat_1.Beat.findOne({ slug: req.params.slug });
        if (!beat || !beat.mp3FreeKey) {
            return res.status(404).json({ message: "Free download not available" });
        }
        if (!(0, storage_1.storedFileExists)("beats", beat.mp3FreeKey)) {
            return res.status(404).json({ message: "File missing on server" });
        }
        const filePath = (0, storage_1.resolveStored)("beats", beat.mp3FreeKey);
        res.download(filePath, `${beat.slug}.mp3`);
    }
    catch (err) {
        next(err);
    }
}
// ----- Merch -----
async function listMerch(req, res, next) {
    try {
        const filter = req.query.featured === "true" ? { isFeatured: true } : {};
        const merch = await MerchProduct_1.MerchProduct.find(filter).sort({ createdAt: -1 });
        res.json(merch.map(serialize_1.publicMerch));
    }
    catch (err) {
        next(err);
    }
}
async function getMerch(req, res, next) {
    try {
        const product = await MerchProduct_1.MerchProduct.findOne({ slug: req.params.slug });
        if (!product)
            return res.status(404).json({ message: "Product not found" });
        res.json((0, serialize_1.publicMerch)(product));
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=catalog.controller.js.map