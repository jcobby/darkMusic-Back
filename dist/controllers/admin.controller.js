"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminListReleases = adminListReleases;
exports.createRelease = createRelease;
exports.updateRelease = updateRelease;
exports.deleteRelease = deleteRelease;
exports.adminListBeats = adminListBeats;
exports.createBeat = createBeat;
exports.updateBeat = updateBeat;
exports.deleteBeat = deleteBeat;
exports.adminListMerch = adminListMerch;
exports.createMerch = createMerch;
exports.updateMerch = updateMerch;
exports.deleteMerch = deleteMerch;
exports.adminListInquiries = adminListInquiries;
exports.updateInquiry = updateInquiry;
exports.adminListOrders = adminListOrders;
const Release_1 = require("../models/Release");
const Beat_1 = require("../models/Beat");
const MerchProduct_1 = require("../models/MerchProduct");
const Inquiry_1 = require("../models/Inquiry");
const Order_1 = require("../models/Order");
const slug_1 = require("../utils/slug");
const upload_1 = require("../services/upload");
// ---------- helpers ----------
const asBool = (v) => v === true || v === "true" || v === "on" || v === "1";
const asNum = (v, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
};
const asList = (v) => {
    if (Array.isArray(v))
        return v.map(String);
    if (typeof v === "string" && v.trim())
        return v.split(",").map((s) => s.trim()).filter(Boolean);
    return [];
};
async function uniqueSlug(model, base, currentId) {
    const root = (0, slug_1.slugify)(base) || "item";
    let slug = root;
    let n = 1;
    // eslint-disable-next-line no-await-in-loop
    while (await model.exists({ slug, ...(currentId ? { _id: { $ne: currentId } } : {}) })) {
        slug = `${root}-${++n}`;
    }
    return slug;
}
function files(req) {
    return req.files;
}
// ---------- Releases ----------
async function adminListReleases(_req, res, next) {
    try {
        res.json(await Release_1.Release.find().sort({ order: 1, createdAt: -1 }));
    }
    catch (err) {
        next(err);
    }
}
async function createRelease(req, res, next) {
    try {
        const b = req.body ?? {};
        if (!b.title)
            return res.status(400).json({ message: "Title is required" });
        const release = await Release_1.Release.create({
            title: b.title,
            slug: await uniqueSlug(Release_1.Release, b.slug || b.title),
            spotifyUrl: b.spotifyUrl,
            appleUrl: b.appleUrl,
            youtubeUrl: b.youtubeUrl,
            isFeatured: asBool(b.isFeatured),
            downloadable: asBool(b.downloadable),
            priceGhs: asNum(b.priceGhs, 10),
            order: asNum(b.order, 0),
            coverImage: (0, upload_1.fileName)(files(req), "cover"),
            audioKey: (0, upload_1.fileName)(files(req), "audio"),
        });
        res.status(201).json(release);
    }
    catch (err) {
        next(err);
    }
}
async function updateRelease(req, res, next) {
    try {
        const release = await Release_1.Release.findById(req.params.id);
        if (!release)
            return res.status(404).json({ message: "Release not found" });
        const b = req.body ?? {};
        if (b.title)
            release.title = b.title;
        if (b.slug)
            release.slug = await uniqueSlug(Release_1.Release, b.slug, String(release._id));
        if (b.spotifyUrl !== undefined)
            release.spotifyUrl = b.spotifyUrl;
        if (b.appleUrl !== undefined)
            release.appleUrl = b.appleUrl;
        if (b.youtubeUrl !== undefined)
            release.youtubeUrl = b.youtubeUrl;
        if (b.isFeatured !== undefined)
            release.isFeatured = asBool(b.isFeatured);
        if (b.downloadable !== undefined)
            release.downloadable = asBool(b.downloadable);
        if (b.priceGhs !== undefined)
            release.priceGhs = asNum(b.priceGhs, release.priceGhs);
        if (b.order !== undefined)
            release.order = asNum(b.order, release.order);
        const cover = (0, upload_1.fileName)(files(req), "cover");
        const audio = (0, upload_1.fileName)(files(req), "audio");
        if (cover)
            release.coverImage = cover;
        if (audio)
            release.audioKey = audio;
        await release.save();
        res.json(release);
    }
    catch (err) {
        next(err);
    }
}
async function deleteRelease(req, res, next) {
    try {
        const r = await Release_1.Release.findByIdAndDelete(req.params.id);
        if (!r)
            return res.status(404).json({ message: "Release not found" });
        res.status(204).send();
    }
    catch (err) {
        next(err);
    }
}
// ---------- Beats ----------
async function adminListBeats(_req, res, next) {
    try {
        res.json(await Beat_1.Beat.find().sort({ order: 1, createdAt: -1 }));
    }
    catch (err) {
        next(err);
    }
}
async function createBeat(req, res, next) {
    try {
        const b = req.body ?? {};
        if (!b.title)
            return res.status(400).json({ message: "Title is required" });
        const beat = await Beat_1.Beat.create({
            title: b.title,
            slug: await uniqueSlug(Beat_1.Beat, b.slug || b.title),
            genre: b.genre,
            wavPriceGhs: asNum(b.wavPriceGhs, 100),
            isFeatured: asBool(b.isFeatured),
            order: asNum(b.order, 0),
            coverImage: (0, upload_1.fileName)(files(req), "cover"),
            mp3FreeKey: (0, upload_1.fileName)(files(req), "mp3Free"),
            wavKey: (0, upload_1.fileName)(files(req), "wav"),
        });
        res.status(201).json(beat);
    }
    catch (err) {
        next(err);
    }
}
async function updateBeat(req, res, next) {
    try {
        const beat = await Beat_1.Beat.findById(req.params.id);
        if (!beat)
            return res.status(404).json({ message: "Beat not found" });
        const b = req.body ?? {};
        if (b.title)
            beat.title = b.title;
        if (b.slug)
            beat.slug = await uniqueSlug(Beat_1.Beat, b.slug, String(beat._id));
        if (b.genre !== undefined)
            beat.genre = b.genre;
        if (b.wavPriceGhs !== undefined)
            beat.wavPriceGhs = asNum(b.wavPriceGhs, beat.wavPriceGhs);
        if (b.isFeatured !== undefined)
            beat.isFeatured = asBool(b.isFeatured);
        if (b.order !== undefined)
            beat.order = asNum(b.order, beat.order);
        const cover = (0, upload_1.fileName)(files(req), "cover");
        const mp3 = (0, upload_1.fileName)(files(req), "mp3Free");
        const wav = (0, upload_1.fileName)(files(req), "wav");
        if (cover)
            beat.coverImage = cover;
        if (mp3)
            beat.mp3FreeKey = mp3;
        if (wav)
            beat.wavKey = wav;
        await beat.save();
        res.json(beat);
    }
    catch (err) {
        next(err);
    }
}
async function deleteBeat(req, res, next) {
    try {
        const b = await Beat_1.Beat.findByIdAndDelete(req.params.id);
        if (!b)
            return res.status(404).json({ message: "Beat not found" });
        res.status(204).send();
    }
    catch (err) {
        next(err);
    }
}
// ---------- Merch ----------
async function adminListMerch(_req, res, next) {
    try {
        res.json(await MerchProduct_1.MerchProduct.find().sort({ createdAt: -1 }));
    }
    catch (err) {
        next(err);
    }
}
async function createMerch(req, res, next) {
    try {
        const b = req.body ?? {};
        if (!b.name)
            return res.status(400).json({ message: "Name is required" });
        const imgs = (files(req)?.images || []).map((f) => f.filename);
        const product = await MerchProduct_1.MerchProduct.create({
            name: b.name,
            slug: await uniqueSlug(MerchProduct_1.MerchProduct, b.slug || b.name),
            description: b.description,
            category: b.category || "tshirt",
            priceGhs: asNum(b.priceGhs, 0),
            sizes: asList(b.sizes),
            stock: asNum(b.stock, 0),
            isLimited: asBool(b.isLimited),
            isSigned: asBool(b.isSigned),
            isFeatured: asBool(b.isFeatured),
            images: imgs,
        });
        res.status(201).json(product);
    }
    catch (err) {
        next(err);
    }
}
async function updateMerch(req, res, next) {
    try {
        const product = await MerchProduct_1.MerchProduct.findById(req.params.id);
        if (!product)
            return res.status(404).json({ message: "Product not found" });
        const b = req.body ?? {};
        if (b.name)
            product.name = b.name;
        if (b.slug)
            product.slug = await uniqueSlug(MerchProduct_1.MerchProduct, b.slug, String(product._id));
        if (b.description !== undefined)
            product.description = b.description;
        if (b.category)
            product.category = b.category;
        if (b.priceGhs !== undefined)
            product.priceGhs = asNum(b.priceGhs, product.priceGhs);
        if (b.sizes !== undefined)
            product.sizes = asList(b.sizes);
        if (b.stock !== undefined)
            product.stock = asNum(b.stock, product.stock);
        if (b.isLimited !== undefined)
            product.isLimited = asBool(b.isLimited);
        if (b.isSigned !== undefined)
            product.isSigned = asBool(b.isSigned);
        if (b.isFeatured !== undefined)
            product.isFeatured = asBool(b.isFeatured);
        const newImgs = (files(req)?.images || []).map((f) => f.filename);
        if (newImgs.length)
            product.images = [...product.images, ...newImgs];
        await product.save();
        res.json(product);
    }
    catch (err) {
        next(err);
    }
}
async function deleteMerch(req, res, next) {
    try {
        const m = await MerchProduct_1.MerchProduct.findByIdAndDelete(req.params.id);
        if (!m)
            return res.status(404).json({ message: "Product not found" });
        res.status(204).send();
    }
    catch (err) {
        next(err);
    }
}
// ---------- Inquiries & Orders ----------
async function adminListInquiries(req, res, next) {
    try {
        const filter = req.query.type ? { type: req.query.type } : {};
        res.json(await Inquiry_1.Inquiry.find(filter).sort({ createdAt: -1 }));
    }
    catch (err) {
        next(err);
    }
}
async function updateInquiry(req, res, next) {
    try {
        const inquiry = await Inquiry_1.Inquiry.findByIdAndUpdate(req.params.id, { status: req.body?.status }, { new: true });
        if (!inquiry)
            return res.status(404).json({ message: "Inquiry not found" });
        res.json(inquiry);
    }
    catch (err) {
        next(err);
    }
}
async function adminListOrders(_req, res, next) {
    try {
        res.json(await Order_1.Order.find().sort({ createdAt: -1 }).limit(200));
    }
    catch (err) {
        next(err);
    }
}
//# sourceMappingURL=admin.controller.js.map