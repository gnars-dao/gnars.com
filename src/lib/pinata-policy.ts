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
