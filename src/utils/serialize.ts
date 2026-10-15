import { IRelease } from "../models/Release";
import { IBeat } from "../models/Beat";
import { IMerchProduct, AUCTION_RUN_DAYS } from "../models/MerchProduct";
import { IModelProfile } from "../models/ModelProfile";
import { MODELS_MARKET } from "../config/modelsMarket";
import { imageUrl } from "./media";
import { freeBeatStreamUrl, freeBeatDownloadUrl } from "../services/cloudinary";

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
    // Direct Cloudinary URLs (free beats are public) — avoids a backend redirect.
    streamUrl: b.mp3FreeKey ? freeBeatStreamUrl(b.mp3FreeKey) : null,
    downloadUrl: b.mp3FreeKey ? freeBeatDownloadUrl(b.mp3FreeKey) : null,
    wavAvailable: Boolean(b.wavKey),
    wavPriceGhs: b.wavPriceGhs,
    isFeatured: b.isFeatured,
  };
}

/** Open for bids, but nobody has bid yet — so the clock hasn't started. */
export const awaitingFirstBid = (m: IMerchProduct) =>
  Boolean(m.auction?.enabled && !m.auction.closedAt && !(m.auction.bidCount > 0));
/** Taking bids: waiting for the first one, or the clock is still running. */
export const isLive = (m: IMerchProduct, now = Date.now()) =>
  Boolean(
    m.auction?.enabled &&
      !m.auction.closedAt &&
      (awaitingFirstBid(m) || (m.auction.endsAt && m.auction.endsAt.getTime() > now))
  );
/** The clock ran out on an auction that had bids (or it was already closed). */
export const hasEnded = (m: IMerchProduct, now = Date.now()) =>
  Boolean(
    m.auction?.enabled &&
      m.auction.endsAt &&
      m.auction.endsAt.getTime() <= now &&
      (m.auction.bidCount > 0 || m.auction.closedAt)
  );

/** Lowest bid that would be accepted right now. */
export const minNextBid = (m: IMerchProduct) =>
  m.auction.highBidGhs != null ? m.auction.highBidGhs + m.auction.minIncrementGhs : m.auction.startingBidGhs;

/** Where a product lives on the site. */
export const productPath = (m: Pick<IMerchProduct, "kind" | "slug">) =>
  m.kind === "worn" ? `/worn-on-set/${m.slug}` : `/merch/${m.slug}`;

/** Public auction state (null when the item isn't up for auction). */
export function publicAuction(m: IMerchProduct) {
  const a = m.auction;
  if (!a?.enabled) return null;
  const waiting = awaitingFirstBid(m);
  return {
    status: isLive(m)
      ? ("live" as const)
      : a.paidAt
      ? ("sold" as const)
      : a.unsold
      ? ("unsold" as const)
      : ("ended" as const),
    startingBidGhs: a.startingBidGhs,
    minIncrementGhs: a.minIncrementGhs,
    /** null until the first bid starts the clock */
    endsAt: waiting ? null : a.endsAt ?? null,
    awaitingFirstBid: waiting,
    runDays: AUCTION_RUN_DAYS,
    payWindowHours: a.payWindowHours ?? 48,
    payBy: a.payBy ?? null, // the current winner's payment deadline
    highBidGhs: a.highBidGhs ?? null,
    leader: a.highBidder ? a.highBidderName || "Fan" : null,
    bidCount: a.bidCount || 0,
    minNextBidGhs: minNextBid(m),
  };
}

export function publicMerch(m: IMerchProduct) {
  return {
    id: m._id,
    name: m.name,
    slug: m.slug,
    kind: m.kind ?? "shop",
    path: productPath(m),
    description: m.description || null,
    condition: m.condition || null,
    wornIn: m.wornIn || null,
    images: (m.images || []).map((i) => imageUrl(i)).filter(Boolean),
    category: m.category,
    priceGhs: m.priceGhs,
    sizes: m.sizes || [],
    stock: m.stock,
    isLimited: m.isLimited,
    isSigned: m.isSigned,
    isFeatured: m.isFeatured,
    inStock: m.stock > 0,
    auction: publicAuction(m),
  };
}

/** Public model shape — hides legal name, age, weight and contact details. */
export function publicModel(m: IModelProfile) {
  return {
    id: m._id,
    name: m.name,
    slug: m.slug,
    photos: (m.photos || []).map((i) => imageUrl(i)).filter(Boolean),
    video: m.video || null,
    bio: m.bio || null,
    isFeatured: m.isFeatured,
    location: m.location || null,
    height: m.height || null,
    experience: m.experience || null,
    categories: m.categories || [],
    languages: m.languages || [],
    rateGhs: m.rateGhs || MODELS_MARKET.minRateGhs,
    availability: m.availability || null,
    instagram: m.instagram || null,
    tiktok: m.tiktok || null,
    rating: m.ratingCount
      ? { avg: Math.round(m.ratingAvg * 10) / 10, count: m.ratingCount }
      : null,
  };
}

/** The model's own view of their profile (adds the private fields + status). */
export function privateModel(m: IModelProfile) {
  return {
    ...publicModel(m),
    status: m.status,
    hidden: m.hidden,
    legalName: m.legalName || null,
    phone: m.phone || null,
    email: m.email || null,
    age: m.age ?? null,
    weight: m.weight || null,
  };
}
