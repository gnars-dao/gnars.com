import { getAddress, type Hex } from "viem";
import { z } from "zod";
import { getMarketplaceProtocolAddress } from "./routing";

export const communityListingCommentSchema = z
  .string()
  .trim()
  .min(1)
  .max(280)
  .refine(
    (value) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value),
    "Unsupported control character",
  );
export const communityPublicationSchema = z
  .object({
    listingComment: communityListingCommentSchema.optional(),
    authorization: z.unknown().optional(),
  })
  .strict()
  .refine(
    (value) => value.authorization === undefined || value.listingComment !== undefined,
    "Authorization requires a listing comment",
  );

export function communityCommentPayload(orderHash: Hex, listingComment: string) {
  return {
    chainId: 8453,
    protocolAddress: getAddress(getMarketplaceProtocolAddress("gnars-contract")),
    orderHash: orderHash.toLowerCase(),
    listingComment: communityListingCommentSchema.parse(listingComment),
  };
}
