import { IRelease } from "../models/Release";
import { IBeat } from "../models/Beat";
import { IMerchProduct } from "../models/MerchProduct";
import { imageUrl } from "./media";

/** Public release shape — hides the deliverable audio file key. */
export function publicRelease(r: IRelease) {
  return {
    id: r._id,
    title: r.title,
    slug: r.slug,
    coverImage: imageUrl(r.coverImage),
    spotifyUrl: r.spotifyUrl || null,
    appleUrl: r.appleUrl || null,
    youtubeUrl: r.youtubeUrl || null,
    isFeatured: r.isFeatured,
    isWelcome: r.isWelcome,
    downloadable: r.downloadable && Boolean(r.audioKey),
    hasPreview: Boolean(r.audioKey), // a ~30s preview is available when audio is uploaded
    priceGhs: r.priceGhs,
  };
}

/** Public beat shape — exposes availability flags, hides file keys. */
export function publicBeat(b: IBeat) {
  return {
    id: b._id,
    title: b.title,
    slug: b.slug,
    coverImage: imageUrl(b.coverImage),
    genre: b.genre || null,
    hasFreeMp3: Boolean(b.mp3FreeKey),
    wavAvailable: Boolean(b.wavKey),
    wavPriceGhs: b.wavPriceGhs,
    isFeatured: b.isFeatured,
  };
}

export function publicMerch(m: IMerchProduct) {
  return {
    id: m._id,
    name: m.name,
    slug: m.slug,
    description: m.description || null,
    images: (m.images || []).map((i) => imageUrl(i)).filter(Boolean),
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
