import fs from "fs";
import path from "path";
import { env } from "../config/env";

/**
 * Local disk storage layout (all under backend/storage, gitignored):
 *   images/  — public cover & merch images, served statically at /uploads
 *   audio/   — release MP3s, delivered only via download tokens
 *   beats/   — beat free MP3s (controlled stream) + paid WAVs (token only)
 */
export const STORAGE = {
  images: path.join(env.storageDir, "images"),
  audio: path.join(env.storageDir, "audio"),
  beats: path.join(env.storageDir, "beats"),
} as const;

export type StorageBucket = keyof typeof STORAGE;

export function ensureStorageDirs(): void {
  for (const dir of Object.values(STORAGE)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function resolveStored(bucket: StorageBucket, filename: string): string {
  // Guard against path traversal — only allow a bare filename.
  const safe = path.basename(filename);
  return path.join(STORAGE[bucket], safe);
}

export function storedFileExists(bucket: StorageBucket, filename?: string): boolean {
  if (!filename) return false;
  return fs.existsSync(resolveStored(bucket, filename));
}
