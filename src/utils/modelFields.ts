import { MODELS_MARKET, MODEL_CATEGORIES } from "../config/modelsMarket";
import { IModelProfile } from "../models/ModelProfile";

export type ModelFieldKey =
  | "legalName"
  | "phone"
  | "email"
  | "location"
  | "age"
  | "height"
  | "weight"
  | "experience"
  | "bio"
  | "availability"
  | "categories"
  | "languages"
  | "rateGhs"
  | "instagram"
  | "tiktok";

/** Fields a model may change on their own live profile (not identity/age). */
export const SELF_EDITABLE: readonly ModelFieldKey[] = [
  "phone",
  "location",
  "height",
  "weight",
  "experience",
  "bio",
  "availability",
  "categories",
  "languages",
  "rateGhs",
  "instagram",
  "tiktok",
];

export const ALL_MODEL_FIELDS = [...SELF_EDITABLE, "legalName", "email", "age"] as const;

const isEmail = (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

const str = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.trim().slice(0, max);
  return s || undefined;
};

/** Accepts an array (repeated form field) or a comma-separated string. */
export const asList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
};

/** Accepts "@name", "name" or a profile URL; returns the bare handle. */
export function socialHandle(v: unknown): string | undefined {
  const s = str(v, 200);
  if (!s) return undefined;
  const fromUrl = s.match(/(?:instagram\.com|tiktok\.com)\/@?([A-Za-z0-9._]+)/i);
  const handle = (fromUrl ? fromUrl[1] : s).replace(/^@/, "");
  return /^[A-Za-z0-9._]{1,30}$/.test(handle) ? handle : undefined;
}

type Parsed = { value: unknown } | { error: string };

const social = (label: string) => (v: unknown): Parsed => {
  if (!str(v, 200)) return { value: undefined };
  const handle = socialHandle(v);
  return handle ? { value: handle } : { error: `That ${label} handle doesn't look right` };
};

const PARSERS: Record<ModelFieldKey, (v: unknown) => Parsed> = {
  legalName: (v) => ({ value: str(v, 120) }),
  phone: (v) => ({ value: str(v, 30) }),
  email: (v) => {
    const s = str(v, 200)?.toLowerCase();
    return s && !isEmail(s) ? { error: "Enter a valid contact email" } : { value: s };
  },
  location: (v) => ({ value: str(v, 120) }),
  age: (v) => {
    if (v === "" || v === undefined || v === null) return { value: undefined };
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n > 100) return { error: "Enter a valid age" };
    if (n < MODELS_MARKET.minAge) {
      return { error: `Models must be ${MODELS_MARKET.minAge} or older` };
    }
    return { value: n };
  },
  height: (v) => ({ value: str(v, 20) }),
  weight: (v) => ({ value: str(v, 20) }),
  experience: (v) => ({ value: str(v, 1000) }),
  bio: (v) => ({ value: str(v, 1000) }),
  availability: (v) => ({ value: str(v, 300) }),
  categories: (v) => {
    // Match case-insensitively (the admin form is free text), keep the canonical spelling.
    const canonical = new Map<string, string>(MODEL_CATEGORIES.map((c) => [c.toLowerCase(), c]));
    const picked = asList(v)
      .map((c) => canonical.get(c.toLowerCase()))
      .filter((c): c is string => Boolean(c));
    return { value: [...new Set(picked)] };
  },
  languages: (v) => ({ value: asList(v).map((s) => s.slice(0, 30)).slice(0, 10) }),
  rateGhs: (v) => {
    if (v === "" || v === undefined || v === null) return { value: undefined };
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < MODELS_MARKET.minRateGhs) {
      return {
        error: `Starting rate must be at least GH₵${MODELS_MARKET.minRateGhs.toLocaleString()}`,
      };
    }
    return { value: n };
  },
  instagram: social("Instagram"),
  tiktok: social("TikTok"),
};

/**
 * Read + validate the given profile fields from a request body. Only keys
 * present in the body come back, so it works for partial updates; an empty
 * value clears the field.
 */
export function readModelFields(
  body: Record<string, unknown>,
  keys: readonly ModelFieldKey[]
): { fields: Partial<Pick<IModelProfile, ModelFieldKey>>; error?: string } {
  const fields: Record<string, unknown> = {};
  for (const key of keys) {
    if (body[key] === undefined) continue;
    const parsed = PARSERS[key](body[key]);
    if ("error" in parsed) return { fields: {}, error: parsed.error };
    fields[key] = parsed.value;
  }
  return { fields: fields as Partial<Pick<IModelProfile, ModelFieldKey>> };
}
