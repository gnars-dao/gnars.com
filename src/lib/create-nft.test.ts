import { describe, expect, it } from "vitest";
import {
  nftCreationJournalSchema,
  nftCreationStorageKey,
  nftMetadataSchema,
} from "@/lib/create-nft";

const address = "0x8Bf5941d27176242745B716251943Ae4892a3C26";
const uri = "ipfs://bafybeib7irehgjoi27ikzc3p3isxo35vh6hcjjbuhz37wpikpj56p6dxvq";
describe("NFT creation data", () => {
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
