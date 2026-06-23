import multer from "multer";

/**
 * Files are buffered in memory, then streamed to Cloudinary by the admin
 * controller (see services/cloudinary.ts). Routes pick fields via `.fields([...])`.
 */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

export type UploadedFiles = Record<string, Express.Multer.File[]>;
