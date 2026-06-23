"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicRelease = publicRelease;
exports.publicBeat = publicBeat;
exports.publicMerch = publicMerch;
const media_1 = require("./media");
/** Public release shape — hides the deliverable audio file key. */
function publicRelease(r) {
    return {
        id: r._id,
        title: r.title,
        slug: r.slug,
        coverImage: (0, media_1.imageUrl)(r.coverImage),
        spotifyUrl: r.spotifyUrl || null,
        appleUrl: r.appleUrl || null,
        youtubeUrl: r.youtubeUrl || null,
        isFeatured: r.isFeatured,
        downloadable: r.downloadable && Boolean(r.audioKey),
        hasPreview: Boolean(r.audioKey), // a ~30s preview is available when audio is uploaded
        priceGhs: r.priceGhs,
    };
}
/** Public beat shape — exposes availability flags, hides file keys. */
function publicBeat(b) {
    return {
        id: b._id,
        title: b.title,
        slug: b.slug,
        coverImage: (0, media_1.imageUrl)(b.coverImage),
        genre: b.genre || null,
        hasFreeMp3: Boolean(b.mp3FreeKey),
        wavAvailable: Boolean(b.wavKey),
        wavPriceGhs: b.wavPriceGhs,
        isFeatured: b.isFeatured,
    };
}
function publicMerch(m) {
    return {
        id: m._id,
        name: m.name,
        slug: m.slug,
        description: m.description || null,
        images: (m.images || []).map((i) => (0, media_1.imageUrl)(i)).filter(Boolean),
        category: m.category,
        priceGhs: m.priceGhs,
        sizes: m.sizes || [],
        stock: m.stock,
        isLimited: m.isLimited,
        isSigned: m.isSigned,
        isFeatured: m.isFeatured,
        inStock: m.stock > 0,
    };
}
//# sourceMappingURL=serialize.js.map