import "server-only";
import { erc721Abi, type Address } from "viem";
import { z } from "zod";
import { DAO_ADDRESSES } from "@/lib/config";
import { encodeOpenSeaFulfillment } from "@/lib/marketplace/opensea-fulfillment";
import { getListingFulfillment, validateListingOnchain } from "@/lib/marketplace/seaport";
import { RequestSecurityError } from "@/lib/server/request-security";
import {
  marketplaceAddressSchema,
  marketplaceClient,
  marketplaceHashSchema,
  marketplaceUintSchema,
} from "@/services/marketplace-common";
import {
  getOpenSeaMarketplaceOrder,
  requestOpenSeaFulfillment,
} from "@/services/marketplace-opensea";
import { getMarketplaceOrder, localMarketplaceOffer } from "@/services/marketplace-orders";
import type { MarketplaceFulfillment } from "@/types/marketplace";

export const marketplaceFulfillmentSchema = z
  .object({
    source: z.enum(["gnars", "opensea"]),
    orderHash: marketplaceHashSchema,
    tokenId: marketplaceUintSchema,
    buyer: marketplaceAddressSchema,
    expectedPriceWei: marketplaceUintSchema,
  })
  .strict();

export async function prepareMarketplaceFulfillment(
  input: z.infer<typeof marketplaceFulfillmentSchema>,
): Promise<MarketplaceFulfillment> {
  if (input.source === "opensea") {
    const order = await getOpenSeaMarketplaceOrder(input.orderHash);
    if (
      order.tokenId !== input.tokenId ||
      order.offer.priceWei !== input.expectedPriceWei ||
      order.offer.orderHash.toLowerCase() !== input.orderHash.toLowerCase()
    ) {
      throw new RequestSecurityError(
        409,
        "The OpenSea listing changed. Refresh before purchasing.",
      );
    }
    if (order.offer.seller.toLowerCase() === input.buyer.toLowerCase())
      throw new RequestSecurityError(400, "You already own this NFT.");
    const owner = await marketplaceClient.readContract({
      address: DAO_ADDRESSES.token,
      abi: erc721Abi,
      functionName: "ownerOf",
      args: [BigInt(input.tokenId)],
    });
    if (owner.toLowerCase() !== order.offer.seller.toLowerCase())
      throw new RequestSecurityError(409, "The seller no longer owns this NFT.");
    const raw = await requestOpenSeaFulfillment(
      input.orderHash,
      input.tokenId,
      input.buyer as Address,
    );
    const transaction = encodeOpenSeaFulfillment(raw, {
      offer: order.offer,
      tokenId: input.tokenId,
      buyer: input.buyer as Address,
    });
    await marketplaceClient.call({ account: input.buyer as Address, ...transaction });
    return {
      offer: order.offer,
      transaction: { chainId: 8453, ...transaction, value: transaction.value.toString() },
    };
  }
  const listing = await getMarketplaceOrder(input.orderHash);
  const offer = localMarketplaceOffer(listing);
  if (
    listing.parameters.offer[0].identifierOrCriteria !== input.tokenId ||
    offer.orderHash.toLowerCase() !== input.orderHash.toLowerCase()
  ) {
    throw new RequestSecurityError(409, "The listing does not match the selected NFT.");
  }
  if (offer.priceWei !== input.expectedPriceWei)
    throw new RequestSecurityError(409, "The listing price changed. Refresh before purchasing.");
  if (offer.seller.toLowerCase() === input.buyer.toLowerCase())
    throw new RequestSecurityError(400, "You already own this NFT.");
  await validateListingOnchain(marketplaceClient, listing, { requireApproval: true });
  const transaction = getListingFulfillment(listing);
  // Simulate the exact value/calldata for this buyer after revalidating the order.
  await marketplaceClient.call({ account: input.buyer as Address, ...transaction });
  return {
    offer,
    transaction: { chainId: 8453, ...transaction, value: transaction.value.toString() },
  };
}
