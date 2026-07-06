import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env";
import { MerchProduct, MerchCategory } from "../models/MerchProduct";
import { slugify } from "../utils/slug";

/**
 * Adds the merch line-up so it shows on /merch. Each item is VISIBLE with a
 * PLACEHOLDER price but stock 0 — so it displays (as "Sold out") yet cannot be
 * bought at a made-up price. In the dashboard, add a photo, set the real price
 * and stock to open it for sale.
 *
 * `priceGhs` values below are placeholders — confirm/replace them.
 * Idempotent: uses $setOnInsert, so re-running never overwrites your edits.
 * Run with:  npm run seed:merch
 */
const ITEMS: { name: string; category: MerchCategory; priceGhs: number; sizes?: string[] }[] = [
  { name: "T-Shirt", category: "tshirt", priceGhs: 150, sizes: ["S", "M", "L", "XL"] },
  { name: "Jersey", category: "jersey", priceGhs: 250, sizes: ["S", "M", "L", "XL"] },
  { name: "Cap", category: "cap", priceGhs: 100 },
  { name: "Socks", category: "socks", priceGhs: 60 },
  { name: "Wrist Band", category: "wristband", priceGhs: 50 },
  { name: "Bandana", category: "bandana", priceGhs: 70 },
  { name: "Book", category: "book", priceGhs: 80 },
  { name: "Pen", category: "pen", priceGhs: 30 },
];

async function run() {
  await mongoose.connect(env.mongoUri);
  console.log("Connected to MongoDB. Staging merch drafts…\n");

  for (const it of ITEMS) {
    const slug = slugify(it.name);
    const res = await MerchProduct.updateOne(
      { slug },
      {
        $setOnInsert: {
          name: it.name,
          slug,
          category: it.category,
          sizes: it.sizes ?? [],
          priceGhs: it.priceGhs, // placeholder — confirm in the dashboard
          stock: 0, // shows "Sold out" until you set real stock (prevents mis-priced sales)
          hidden: false, // visible on /merch
          images: [],
          description: "Placeholder price — set the real price, add photos and stock in the dashboard to open sales.",
        },
      },
      { upsert: true }
    );
    console.log(` - ${it.name} [${it.category}] → ${res.upsertedCount ? "created" : "already exists (kept)"}`);
  }

  await mongoose.disconnect();
  console.log("\nDone. Finish each item in /admin (photo, price, stock) then unhide it.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
