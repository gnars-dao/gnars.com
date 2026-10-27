import { z } from "zod";

export const MAX_VIDEO_UPLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_MEDIA_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Signed upload URL lifetime: 5 min plus the file's transfer time at ~50 KB/s
 * (slow mobile uplink), capped at 30 min. A short fixed expiry made phone videos
 * fail mid-upload; scaling keeps small files' URLs short-lived.
 */
export function signedUploadExpirySeconds(size: number) {
  return Math.min(1800, 300 + Math.ceil(size / 50_000));
}

/**
 * Pinata counts a few KB more than the file against `max_file_size` (measured: up to
 * ~16 KB over at 80 MB), so an exact limit rejected every upload over ~500 KB.
 * Accepted trade-off: a file can exceed the declared size (and the hourly byte budget)
 * by at most this much per upload. Don't shrink it to tighten the 100/500 MiB caps.
 */
export const SIGNED_UPLOAD_SIZE_HEADROOM_BYTES = 1024 * 1024;

const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  mov: "video/quicktime",
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  webm: "video/webm",
  "3gp": "video/3gpp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
};

/**
 * Some browsers leave `File.type` empty for media they don't know (e.g. Brave on
 * Linux with `.MOV`); fall back to the extension so the upload isn't rejected.
 */
export function uploadMimeType(file: { name: string; type: string }) {
  if (file.type && file.type !== "application/octet-stream") return file.type;
  const dot = file.name.lastIndexOf(".");
  const extension = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  return MIME_TYPES_BY_EXTENSION[extension] ?? file.type;
}

export const pinataUploadSchema = z
  .object({
    filename: z.string().trim().min(1).max(255),
    mimeType: z.string().regex(/^(image|video|audio)\/[a-zA-Z0-9.+-]+$/),
    size: z.number().int().positive(),
  })
  .superRefine((file, context) => {
    const limit = file.mimeType.startsWith("video/")
      ? MAX_VIDEO_UPLOAD_BYTES
      : MAX_MEDIA_UPLOAD_BYTES;
    if (file.size > limit)
      context.addIssue({
        code: "custom",
        path: ["size"],
        message: "File exceeds upload size limit.",
      });
  });
