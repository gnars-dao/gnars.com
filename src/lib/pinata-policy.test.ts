import { describe, expect, it } from "vitest";
import {
  MAX_MEDIA_UPLOAD_BYTES,
  MAX_VIDEO_UPLOAD_BYTES,
  pinataUploadSchema,
} from "./pinata-policy";

describe("Pinata upload policy", () => {
  const file = { filename: "clip.mp4", mimeType: "video/mp4", size: MAX_VIDEO_UPLOAD_BYTES };
  it("allows media within the per-type size bounds", () => {
    expect(pinataUploadSchema.safeParse(file).success).toBe(true);
    expect(
      pinataUploadSchema.safeParse({ ...file, mimeType: "image/png", size: MAX_MEDIA_UPLOAD_BYTES })
        .success,
    ).toBe(true);
  });
  it("rejects missing, wildcard or arbitrary MIME types and oversize payloads", () => {
    for (const value of [
      { ...file, mimeType: "" },
      { ...file, mimeType: "image/*" },
      { ...file, mimeType: "text/html" },
      { ...file, size: MAX_VIDEO_UPLOAD_BYTES + 1 },
      { ...file, mimeType: "image/png", size: MAX_MEDIA_UPLOAD_BYTES + 1 },
      { ...file, size: 0 },
      { ...file, filename: "x".repeat(256) },
    ])
      expect(pinataUploadSchema.safeParse(value).success).toBe(false);
  });
});
