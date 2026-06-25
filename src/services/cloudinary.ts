import { v2 as cloudinary } from "cloudinary";
import { env, isCloudinaryConfigured } from "../config/env";

if (isCloudinaryConfigured()) {
  cloudinary.config({
    cloud_name: env.cloudinary.cloudName,
    api_key: env.cloudinary.apiKey,
    api_secret: env.cloudinary.apiSecret,
    secure: true,
  });
}

/**
 * image       — public images (covers, merch). Stored as a full URL.
 * audioPublic — free beat MP3s (public). Stored as a Cloudinary public_id.
 * audioPrivate— paid release MP3 / beat WAV (access-controlled). public_id.
 */
export type UploadKind = "image" | "audioPublic" | "audioPrivate";

export interface UploadResult {
  url: string;
  publicId: string;
}

function optionsFor(kind: UploadKind) {
  if (kind === "image") {
    return { folder: "dmy/images", resource_type: "image" as const, type: "upload" as const };
  }
  if (kind === "audioPublic") {
    return { folder: "dmy/beats", resource_type: "video" as const, type: "upload" as const };
  }
  // Paid audio — authenticated so it can only be delivered via signed URLs.
  return { folder: "dmy/audio", resource_type: "video" as const, type: "authenticated" as const };
}

/** Upload a file buffer to Cloudinary. */
export function uploadBuffer(buffer: Buffer, kind: UploadKind): Promise<UploadResult> {
  if (!isCloudinaryConfigured()) {
    return Promise.reject(
      Object.assign(new Error("Media storage (Cloudinary) is not configured"), {
        statusCode: 503,
      })
    );
  }
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(optionsFor(kind), (err, result) => {
      if (err || !result) return reject(err || new Error("Upload failed"));
      resolve({ url: result.secure_url, publicId: result.public_id });
    });
    stream.end(buffer);
  });
}

/** Public, inline (streamable) URL for a free beat MP3 — for in-page playback. */
export function freeBeatStreamUrl(publicId: string): string {
  return cloudinary.url(publicId, {
    resource_type: "video",
    type: "upload",
    secure: true,
  });
}

/** Public, download-forcing URL for a free beat MP3 — for the download button. */
export function freeBeatDownloadUrl(publicId: string): string {
  return cloudinary.url(publicId, {
    resource_type: "video",
    type: "upload",
    secure: true,
    flags: "attachment",
  });
}

/** Signed ~45s preview clip of a paid (authenticated) audio asset. */
export function previewUrl(publicId: string): string {
  return cloudinary.url(publicId, {
    resource_type: "video",
    type: "authenticated",
    secure: true,
    sign_url: true,
    transformation: [{ duration: 45 }],
  });
}

/** Signed, download-forcing URL for the full paid (authenticated) audio file. */
export function downloadUrl(publicId: string): string {
  return cloudinary.url(publicId, {
    resource_type: "video",
    type: "authenticated",
    secure: true,
    sign_url: true,
    flags: "attachment",
  });
}
