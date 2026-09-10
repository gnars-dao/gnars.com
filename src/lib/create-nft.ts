import { isAddress, parseAbi, type Address } from "viem";
import { z } from "zod";

export const communityNftAbi = parseAbi([
  "function mint(bytes32 requestId,string uri) returns(uint256)",
  "function mintedRequests(address creator,bytes32 requestId) view returns(uint256)",
  "function creators(uint256 tokenId) view returns(address)",
  "function tokenURI(uint256 tokenId) view returns(string)",
  "function ownerOf(uint256 tokenId) view returns(address)",
  "function gnars() view returns(address)",
  "function royaltyRecipient() view returns(address)",
  "function royaltyBps() view returns(uint96)",
  "function MIN_GNARS() view returns(uint256)",
]);

export function communityNftAddress(): Address | null {
  const address = process.env.NEXT_PUBLIC_GNARS_COMMUNITY_NFT_ADDRESS;
  return address && isAddress(address) ? address : null;
}

export const NFT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const NFT_VIDEO_MAX_BYTES = 200 * 1024 * 1024;
type MediaFile = { type: string; size: number };

export function isNftImageFile(file: MediaFile) {
  return (
    ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type) &&
    file.size > 0 &&
    file.size <= NFT_IMAGE_MAX_BYTES
  );
}

export function isNftMediaFile(file: MediaFile) {
  return (
    isNftImageFile(file) ||
    (file.type === "video/mp4" && file.size > 0 && file.size <= NFT_VIDEO_MAX_BYTES)
  );
}

const nftIpfsUriSchema = z.string().regex(/^ipfs:\/\/[a-zA-Z0-9]{32,100}$/);
export const nftMetadataSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2000),
    image: nftIpfsUriSchema,
    animation_url: nftIpfsUriSchema.optional(),
    animation_details: z
      .object({ type: z.literal("video/mp4") })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => Boolean(value.animation_url) === Boolean(value.animation_details), {
    message: "Video URI and media type must be provided together.",
  });

export const nftCreationJournalSchema = z
  .object({
    account: z.string().refine(isAddress),
    contract: z.string().refine(isAddress),
    requestId: z.string().regex(/^0x[a-f0-9]{64}$/i),
    uri: z.string().regex(/^ipfs:\/\/[a-zA-Z0-9]{32,100}$/),
    name: z.string().min(1).max(100),
    hash: z
      .string()
      .regex(/^0x[a-f0-9]{64}$/i)
      .optional(),
    tokenId: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .optional(),
    failed: z.boolean().optional(),
  })
  .strict();

export type NftCreationJournal = z.infer<typeof nftCreationJournalSchema>;
export function nftCreationStorageKey(account: string, contract: string) {
  return `gnars:create-nft:8453:${contract.toLowerCase()}:${account.toLowerCase()}`;
}
