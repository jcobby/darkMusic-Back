/**
 * DMY Models marketplace rules. The frontend mirrors the lists below in
 * frontend/src/lib/modelsMarket.ts — keep them in sync.
 */
export const MODELS_MARKET = {
  commissionRate: 0.15, // DMY's share of every booking paid through the site
  minRateGhs: 2000, // lowest starting rate a model can list or accept
  minAge: 18,
  minPhotos: 3,
  maxPhotos: 8,
  termsVersion: "2026-10-06", // bump when the Models Terms change
} as const;

export const MODEL_CATEGORIES = [
  "Music videos",
  "Photoshoots",
  "Commercials",
  "Events",
  "Brand promos",
  "Fashion / runway",
  "Hosting",
] as const;

/** Every one of these must be ticked to register (see the Models Terms page). */
export const MODEL_DECLARATIONS = [
  "adult", // I am 18 years or older
  "accurate", // The information I provided is accurate
  "independent", // I am an independent model
  "responsible", // I am responsible for my own services
  "commission", // I agree to DMY's commission
  "terms", // I agree to DMY's Models Terms
  "display", // I authorize DMY to display my submitted photos/profile
] as const;

/** Split a price into DMY's commission and the model's balance (whole cedis). */
export function splitPrice(priceGhs: number) {
  const commissionGhs = Math.round(priceGhs * MODELS_MARKET.commissionRate);
  return { commissionGhs, payoutGhs: priceGhs - commissionGhs };
}
