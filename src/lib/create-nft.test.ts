import { describe, expect, it } from "vitest";
import {
  isNftImageFile,
  isNftMediaFile,
  NFT_IMAGE_MAX_BYTES,
  NFT_VIDEO_MAX_BYTES,
  nftCreationJournalSchema,
  nftCreationStorageKey,
  nftMetadataSchema,
} from "@/lib/create-nft";

const address = "0x8Bf5941d27176242745B716251943Ae4892a3C26";
const uri = "ipfs://bafybeib7irehgjoi27ikzc3p3isxo35vh6hcjjbuhz37wpikpj56p6dxvq";
describe("NFT creation data", () => {
  it("accepts MP4 metadata only with an immutable cover and explicit media type", () => {
    const video = {
      name: "Clip",
      description: "",
      image: uri,
      animation_url: uri,
      animation_details: { type: "video/mp4" },
    };
    expect(nftMetadataSchema.parse(video)).toEqual(video);
    for (const invalid of [
      { ...video, image: undefined },
      { ...video, animation_url: "javascript:alert(1)" },
      { ...video, animation_url: "https://example.com/video.mp4" },
      { ...video, animation_details: undefined },
      { ...video, animation_url: undefined },
      { ...video, animation_details: { type: "text/html" } },
    ])
      expect(nftMetadataSchema.safeParse(invalid).success).toBe(false);
  });
  it("bounds video and image files independently", () => {
    expect(isNftMediaFile({ type: "video/mp4", size: NFT_VIDEO_MAX_BYTES })).toBe(true);
    expect(isNftMediaFile({ type: "video/mp4", size: NFT_VIDEO_MAX_BYTES + 1 })).toBe(false);
    expect(isNftImageFile({ type: "image/png", size: NFT_IMAGE_MAX_BYTES })).toBe(true);
    expect(isNftMediaFile({ type: "image/png", size: NFT_IMAGE_MAX_BYTES + 1 })).toBe(false);
    expect(isNftImageFile({ type: "video/mp4", size: 10 })).toBe(false);
    for (const type of ["text/html", "image/svg+xml", "video/webm", ""]) {
      expect(isNftMediaFile({ type, size: 10 })).toBe(false);
    }
    expect(isNftMediaFile({ type: "video/mp4", size: 0 })).toBe(false);
  });
  it("accepts bounded immutable metadata", () => {
    expect(nftMetadataSchema.parse({ name: " Artwork ", description: "", image: uri }).name).toBe(
      "Artwork",
    );
  });
  it("rejects mutable or injected media and huge names", () => {
    for (const image of [
      "https://example.com/image",
      "javascript:alert(1)",
      "ipfs://localhost/../../x",
    ])
      expect(nftMetadataSchema.safeParse({ name: "Artwork", description: "", image }).success).toBe(
        false,
      );
    expect(
      nftMetadataSchema.safeParse({ name: "x".repeat(101), description: "", image: uri }).success,
    ).toBe(false);
  });
  it("keeps ambiguous pending requests without a hash durable", () => {
    expect(
      nftCreationJournalSchema.parse({
        account: address,
        contract: address,
        requestId: `0x${"ab".repeat(32)}`,
        uri,
        name: "Artwork",
      }).hash,
    ).toBeUndefined();
  });
  it("separates active account and collection journals", () => {
    expect(nftCreationStorageKey(address, address)).toBe(
      nftCreationStorageKey(address.toLowerCase(), address.toLowerCase()),
    );
    expect(nftCreationStorageKey(address, address)).not.toBe(
      nftCreationStorageKey(`0x${"ab".repeat(20)}`, address),
    );
  });
});
