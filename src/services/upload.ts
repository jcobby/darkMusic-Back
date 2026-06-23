import multer from "multer";
import path from "path";
import crypto from "crypto";
import { STORAGE, StorageBucket, ensureStorageDirs } from "./storage";

ensureStorageDirs();

/** Map an upload field name to its storage bucket. */
function bucketForField(fieldname: string): StorageBucket {
  switch (fieldname) {
    case "audio":
      return "audio"; // release MP3 (paid)
    case "mp3Free":
    case "wav":
      return "beats"; // beat files
    default:
      return "images"; // cover / image / images
  }
}

const storage = multer.diskStorage({
  destination: (_req, file, cb) => cb(null, STORAGE[bucketForField(file.fieldname)]),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = crypto.randomBytes(8).toString("hex");
    cb(null, `${Date.now()}-${base}${ext}`);
  },
});

/** Single multer instance; routes choose fields via `.fields([...])`. */
export const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

export type UploadedFiles = Record<string, Express.Multer.File[]>;

/** First uploaded filename for a field, if present. */
export function fileName(files: UploadedFiles | undefined, field: string): string | undefined {
  return files?.[field]?.[0]?.filename;
}
