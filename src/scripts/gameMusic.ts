import "dotenv/config";
import { readFileSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import crypto from "crypto";
import mongoose from "mongoose";
import { env } from "../config/env";
import { GameTrack } from "../models/GameTrack";
import { uploadPrivateAudioFile, gameTrackUrl } from "../services/cloudinary";
import { slugify } from "../utils/slug";

/**
 * Puts the Beat Breaker music in place: uploads each MP3 to Cloudinary as a
 * PRIVATE file (only playable through the site's signed links) and records it.
 *
 *   npm run game-music -- path/to/music.json
 *
 * music.json lives on your computer, NOT in this repository (the repo is public,
 * and an unreleased song's title and audio must not leak):
 * {
 *   "songs": [
 *     { "file": "C:/…/Stubborn Abele.mp3", "title": "Stubborn Abele", "artist": "Lenko Psycho",
 *       "welcome": true, "cover": "https://darkmusicyard.com/releases/stubborn-abele.jpg",
 *       "href": "https://open.spotify.com/track/…" },
 *     …
 *   ],
 *   "unreleased": { "file": "C:/…/New song.mp3", "title": "New song", "artist": "Lenko Psycho" }
 * }
 * File paths are relative to music.json. Re-running is safe: files already on
 * Cloudinary aren't uploaded again, and the list is replaced to match music.json.
 */
interface Entry {
  file: string;
  title: string;
  publicId?: string; // reuse a file already on Cloudinary (e.g. uploaded for another database)
  artist?: string;
  welcome?: boolean;
  cover?: string;
  href?: string;
}
interface Manifest {
  game?: string;
  songs: Entry[];
  unreleased?: Entry | null;
}

/** Request a link until Cloudinary serves it from its cache (answers a byte range with 206). */
async function warm(url: string) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, { headers: { Range: "bytes=0-1023" } }).catch(() => null);
    await r?.arrayBuffer().catch(() => null);
    if (r?.status === 206) return;
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  console.warn(`   (couldn't confirm ${url.slice(0, 60)}… is ready — it'll be made on first play)`);
}

async function run() {
  const manifestPath = process.argv[2];
  if (!manifestPath || !existsSync(manifestPath)) {
    console.error("Usage: npm run game-music -- path/to/music.json");
    process.exitCode = 1;
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const base = dirname(resolve(manifestPath));
  const game = manifest.game || "beat-breaker";
  const all = [
    ...manifest.songs.map((e, i) => ({ ...e, kind: "song" as const, order: i })),
    ...(manifest.unreleased ? [{ ...manifest.unreleased, kind: "unreleased" as const, order: 0 }] : []),
  ];
  for (const e of all) {
    if (!existsSync(resolve(base, e.file))) throw new Error(`File not found: ${e.file}`);
  }

  await mongoose.connect(env.mongoUri);
  console.log(`Connected (${mongoose.connection.db?.databaseName}). Game: ${game}\n`);

  const kept: string[] = [];
  for (const e of all) {
    // The unreleased track gets a random name, so nothing about it shows in links.
    const existing = await GameTrack.findOne({ game, kind: e.kind, title: e.title });
    const publicId =
      existing?.publicId ||
      e.publicId ||
      (e.kind === "unreleased"
        ? `dmy/game-music/u-${crypto.randomBytes(8).toString("hex")}`
        : `dmy/game-music/${slugify(e.title)}`);
    const up = await uploadPrivateAudioFile(resolve(base, e.file), publicId);
    const doc = await GameTrack.findOneAndUpdate(
      { game, kind: e.kind, title: e.title },
      {
        $set: {
          artist: e.artist || "Lenko Psycho",
          publicId: up.publicId,
          order: e.order,
          welcome: Boolean(e.welcome),
          cover: e.cover,
          href: e.href,
          hidden: false,
        },
        $unset: { src: "" },
      },
      { upsert: true, new: true }
    );
    kept.push(String(doc._id));
    // Cloudinary makes the 128 kbps version on first request — and that first
    // reply can't be seeked, which iPhones need. Make it now, not on a fan's phone.
    await warm(gameTrackUrl(up.publicId));
    if (e.welcome) await warm(gameTrackUrl(up.publicId, 45));
    console.log(` - ${e.kind === "unreleased" ? "🔒 unreleased" : "♪ song"}: ${e.title} → ${up.uploaded ? "uploaded" : "already on Cloudinary"}, ready`);
  }
  const removed = await GameTrack.deleteMany({ game, _id: { $nin: kept } });
  if (removed.deletedCount) console.log(` - removed ${removed.deletedCount} track(s) no longer in the list`);

  await mongoose.disconnect();
  console.log("\nDone — Beat Breaker plays the songs from level 4 and the unreleased track from level 21.");
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
