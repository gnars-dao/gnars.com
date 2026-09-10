import { getAddress, type Hex } from "viem";
import { z } from "zod";
import { BUILDER_CODE } from "@/lib/config";
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

export const communityCommentEditSchema = z
  .object({
    chainId: z.literal(8453),
    protocolAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    builderCode: z.literal(BUILDER_CODE),
    orderHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    listingComment: communityListingCommentSchema.nullable(),
    expectedRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    authorization: z.unknown(),
  })
  .strict();

export function communityCommentEditPayload(
  orderHash: Hex,
  listingComment: string | null,
  expectedRevision: number,
) {
  return communityCommentEditSchema.omit({ authorization: true }).parse({
    chainId: 8453,
    protocolAddress: getAddress(getMarketplaceProtocolAddress("gnars-contract")),
    builderCode: BUILDER_CODE,
    orderHash: orderHash.toLowerCase(),
    listingComment,
    expectedRevision,
  });
}
