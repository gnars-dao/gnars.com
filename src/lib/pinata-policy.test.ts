import { describe, expect, it } from "vitest";
import {
  MAX_MEDIA_UPLOAD_BYTES,
  MAX_VIDEO_UPLOAD_BYTES,
  pinataUploadSchema,
  signedUploadExpirySeconds,
  uploadMimeType,
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
  it("scales the signed URL lifetime with file size, capped at 30 minutes", () => {
    expect(signedUploadExpirySeconds(40_000)).toBe(301);
    // 48 MB phone video: 5 min + ~16 min at 50 KB/s.
    expect(signedUploadExpirySeconds(50_739_164)).toBe(1315);
    expect(signedUploadExpirySeconds(MAX_VIDEO_UPLOAD_BYTES)).toBe(1800);
  });
  it("falls back to the extension when the browser leaves the MIME type empty", () => {
    expect(uploadMimeType({ name: "IMG_7910.MOV", type: "" })).toBe("video/quicktime");
    expect(uploadMimeType({ name: "clip.mp4", type: "application/octet-stream" })).toBe(
      "video/mp4",
    );
    expect(uploadMimeType({ name: "clip.mov", type: "video/mp4" })).toBe("video/mp4");
    expect(uploadMimeType({ name: "notes.xyz", type: "" })).toBe("");
  });
});
