"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const mongoose_1 = __importDefault(require("mongoose"));
const env_1 = require("../config/env");
const storage_1 = require("../services/storage");
const Release_1 = require("../models/Release");
const Beat_1 = require("../models/Beat");
const MerchProduct_1 = require("../models/MerchProduct");
/**
 * Seeds the catalog with the spec's example content and writes small placeholder
 * media files so the buy/download flow is testable end-to-end. Replace the
 * placeholder audio with real files via the admin dashboard before going live.
 */
const PLACEHOLDER_NOTE = "DARK MUSIC YARD placeholder media file. Replace with the real audio via /admin.\n";
function writePlaceholder(bucket, filename) {
    const p = path_1.default.join(storage_1.STORAGE[bucket], filename);
    if (!fs_1.default.existsSync(p))
        fs_1.default.writeFileSync(p, PLACEHOLDER_NOTE);
}
async function seed() {
    (0, storage_1.ensureStorageDirs)();
    await mongoose_1.default.connect(env_1.env.mongoUri);
    console.log("Connected to MongoDB:", env_1.env.mongoUri);
    await Promise.all([
        Release_1.Release.deleteMany({}),
        Beat_1.Beat.deleteMany({}),
        MerchProduct_1.MerchProduct.deleteMany({}),
    ]);
    // Placeholder media
    ["save-me.mp3", "chinchilla.mp3"].forEach((f) => writePlaceholder("audio", f));
    ["afrobeat.mp3", "afrobeat.wav", "drill.mp3", "drill.wav"].forEach((f) => writePlaceholder("beats", f));
    await Release_1.Release.create([
        {
            title: "Ambition RMX",
            slug: "ambition-rmx",
            youtubeUrl: "https://www.youtube.com/watch?v=REPLACE_WITH_VIDEO_ID",
            spotifyUrl: "https://open.spotify.com/",
            appleUrl: "https://music.apple.com/",
            isFeatured: true,
            downloadable: false,
            order: 0,
        },
        {
            title: "Save Me",
            slug: "save-me",
            spotifyUrl: "https://open.spotify.com/",
            appleUrl: "https://music.apple.com/",
            youtubeUrl: "https://www.youtube.com/",
            isFeatured: true,
            downloadable: true,
            priceGhs: 10,
            audioKey: "save-me.mp3",
            order: 1,
        },
        {
            title: "Chinchilla",
            slug: "chinchilla",
            spotifyUrl: "https://open.spotify.com/",
            appleUrl: "https://music.apple.com/",
            youtubeUrl: "https://www.youtube.com/",
            isFeatured: true,
            downloadable: true,
            priceGhs: 10,
            audioKey: "chinchilla.mp3",
            order: 2,
        },
    ]);
    await Beat_1.Beat.create([
        {
            title: "Afrobeat Instrumental",
            slug: "afrobeat-instrumental",
            genre: "Afrobeat",
            mp3FreeKey: "afrobeat.mp3",
            wavKey: "afrobeat.wav",
            wavPriceGhs: 100,
            isFeatured: true,
            order: 1,
        },
        {
            title: "Drill Instrumental",
            slug: "drill-instrumental",
            genre: "Drill",
            mp3FreeKey: "drill.mp3",
            wavKey: "drill.wav",
            wavPriceGhs: 100,
            order: 2,
        },
    ]);
    await MerchProduct_1.MerchProduct.create([
        {
            name: "DMY Logo Tee",
            slug: "dmy-logo-tee",
            description: "Black tee with the embroidered Dark Music Yard logo.",
            category: "tshirt",
            priceGhs: 150,
            sizes: ["S", "M", "L", "XL", "XXL"],
            stock: 25,
            isFeatured: true,
        },
        {
            name: "Dark Yard Hoodie",
            slug: "dark-yard-hoodie",
            description: "Heavyweight black hoodie. Stream everywhere, wear it loud.",
            category: "hoodie",
            priceGhs: 350,
            sizes: ["S", "M", "L", "XL"],
            stock: 15,
            isFeatured: true,
        },
        {
            name: "DMY Snapback Cap",
            slug: "dmy-snapback-cap",
            description: "One-size adjustable snapback with the DM Yard mark.",
            category: "cap",
            priceGhs: 90,
            stock: 30,
        },
        {
            name: "Gas Mask Poster",
            slug: "gas-mask-poster",
            description: "A3 matte poster of the signature gas-mask artwork.",
            category: "poster",
            priceGhs: 60,
            stock: 50,
        },
        {
            name: "Signed Limited Tee",
            slug: "signed-limited-tee",
            description: "Hand-signed, numbered limited edition. Only a few exist.",
            category: "signed",
            priceGhs: 400,
            sizes: ["M", "L", "XL"],
            stock: 5,
            isLimited: true,
            isSigned: true,
            isFeatured: true,
        },
    ]);
    console.log("Seed complete: 3 releases, 2 beats, 5 merch products.");
    await mongoose_1.default.disconnect();
}
seed().catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
});
//# sourceMappingURL=seed.js.map