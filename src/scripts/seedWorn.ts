import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env";
import { MerchProduct } from "../models/MerchProduct";
import { slugify } from "../utils/slug";

/**
 * Adds the first Worn on Set pieces (photos live in the frontend at /public/worn)
 * and opens bidding straight away on /worn-on-set; each one's 14-day clock starts with its first bid.
 * Starting bids and end times can be changed any time in /admin → Worn on Set.
 *
 * Run it AFTER deploying both the backend and the frontend — it checks that the
 * live site has Worn on Set and the photos (skip the check with --force).
 * Idempotent: an existing piece (same title) is never touched, so re-running is safe.
 * Run with:  npm run seed:worn        (photo links use SITE_URL, else the live site)
 */
const LIVE_API = (process.env.LIVE_API_URL || "https://darkmusic-back.onrender.com/api").replace(/\/$/, "");
const FORCE = process.argv.includes("--force");

const SITE =
  (process.env.SITE_URL || env.clientUrls.find((u) => !u.includes("localhost")) || "https://darkmusicyard.com").replace(
    /\/$/,
    ""
  );

interface Piece {
  name: string;
  wornIn: string;
  description: string;
  size: string;
  photos: string[]; // files in frontend/public/worn — the first is the main photo
  startingBidGhs: number; // placeholder — confirm in the dashboard
  minIncrementGhs: number;
}

const SHIVER = "Shiver video";
const PIECES: Piece[] = [
  {
    name: "Dark Music Yard Tee — Worn in the “It's Working” video",
    wornIn: "It's Working video",
    description:
      "White Dark Music Yard tee — the DMY cross logo on the chest and www.darkmusicyard.com across the back. Worn by Lenko Psycho in the It's Working video.",
    size: "XL",
    photos: ["dmy-tee-front", "dmy-tee-back"],
    startingBidGhs: 150,
    minIncrementGhs: 20,
  },
  {
    name: "Paisley-Panel Hooded Anorak — Worn in the “Shiver” video",
    wornIn: SHIVER,
    description:
      "Cream hooded anorak with paisley tapestry panels, lettering down the sleeves and across the back, zip front and flap pockets. Worn by Lenko Psycho in the Shiver video.",
    size: "XL",
    photos: ["anorak-front", "anorak-back", "anorak-detail"],
    startingBidGhs: 400,
    minIncrementGhs: 50,
  },
  {
    name: "“ICECREAM” Two-Tone Shirt — Worn in the “Shiver” video",
    wornIn: SHIVER,
    description:
      "Pink-and-red short-sleeve work shirt with red chest pockets and ICECREAM across the back. Worn by Lenko Psycho in the Shiver video.",
    size: "L",
    photos: ["icecream-shirt-front", "icecream-shirt-back", "icecream-shirt-pocket"],
    startingBidGhs: 200,
    minIncrementGhs: 20,
  },
  {
    name: "“Misjudged State 2026” Raglan Tee — Worn in the “Shiver” video",
    wornIn: SHIVER,
    description:
      "Maroon tee with cream raglan sleeves and a MISJUDGED STATE 2026 varsity print. Worn by Lenko Psycho in the Shiver video.",
    size: "XL",
    photos: ["misjudged-tee-front", "misjudged-tee-back", "misjudged-tee-hanging"],
    startingBidGhs: 150,
    minIncrementGhs: 20,
  },
  {
    name: "Snakeskin Trucker Cap — Worn in the “Shiver” video",
    wornIn: SHIVER,
    description:
      "Metallic snakeskin-print trucker cap with a skull emblem on the front and a mesh back. Worn by Lenko Psycho in the Shiver video.",
    size: "XL",
    photos: ["snakeskin-cap-front", "snakeskin-cap-back"],
    startingBidGhs: 120,
    minIncrementGhs: 20,
  },
];

/** Refuse to publish until the live site can actually show the pieces. */
async function checkLive(): Promise<boolean> {
  if (FORCE) return true;
  const checks = [
    { what: "the backend (Worn on Set API)", url: `${LIVE_API}/worn` },
    { what: "the frontend (the photos)", url: `${SITE}/worn/${PIECES[0].photos[0]}.jpg` },
  ];
  for (const c of checks) {
    const ok = await fetch(c.url, { method: "GET" }).then((r) => r.ok).catch(() => false);
    if (!ok) {
      console.error(`✋ ${c.what} isn't live yet (${c.url}). Deploy first, then run this again (or add --force).`);
      return false;
    }
  }
  return true;
}

async function run() {
  if (!(await checkLive())) {
    process.exitCode = 1;
    return;
  }
  await mongoose.connect(env.mongoUri);
  console.log(`Connected. Adding Worn on Set pieces (photos from ${SITE}/worn/)…\n`);

  for (const p of PIECES) {
    const slug = slugify(p.name);
    const res = await MerchProduct.updateOne(
      { slug },
      {
        $setOnInsert: {
          name: p.name,
          slug,
          kind: "worn",
          category: "worn",
          wornIn: p.wornIn,
          description: p.description,
          condition: "Used — worn during the video shoot",
          sizes: [p.size],
          images: p.photos.map((f) => `${SITE}/worn/${f}.jpg`),
          priceGhs: 0,
          stock: 1,
          isLimited: true,
          hidden: false, // live on /worn-on-set straight away
          auction: {
            enabled: true,
            startingBidGhs: p.startingBidGhs,
            minIncrementGhs: p.minIncrementGhs,
            payWindowHours: 48,
            bidCount: 0,
            lapsed: [],
          },
        },
      },
      { upsert: true }
    );
    console.log(` - ${p.name} (${p.size}) · from GH₵${p.startingBidGhs} → ${res.upsertedCount ? "live" : "already exists (kept)"}`);
  }

  await mongoose.disconnect();
  console.log(
    `\nDone — see ${SITE}/worn-on-set. Each piece's 14-day countdown starts with its first bid; change starting bids any time in /admin → Worn on Set.`
  );
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
