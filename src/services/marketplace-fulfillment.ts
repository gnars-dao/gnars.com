import "server-only";
import { erc721Abi, type Address } from "viem";
import { z } from "zod";
import { DAO_ADDRESSES } from "@/lib/config";
import { encodeOpenSeaFulfillment } from "@/lib/marketplace/opensea-fulfillment";
import { getListingFulfillment, validateListingOnchain } from "@/lib/marketplace/seaport";
import {
  marketplaceAddressSchema,
  marketplaceClient,
  marketplaceHashSchema,
  MarketplaceServiceError,
  marketplaceSimulationError,
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
      throw new MarketplaceServiceError(
        409,
        "The OpenSea listing changed. Refresh before purchasing.",
        "ORDER_CHANGED",
        false,
      );
    }
    if (order.offer.seller.toLowerCase() === input.buyer.toLowerCase())
      throw new MarketplaceServiceError(
        409,
        "You already own this NFT.",
        "ORDER_ALREADY_OWNED",
        false,
      );
    const owner = await marketplaceClient.readContract({
      address: DAO_ADDRESSES.token,
      abi: erc721Abi,
      functionName: "ownerOf",
      args: [BigInt(input.tokenId)],
    });
    if (owner.toLowerCase() !== order.offer.seller.toLowerCase())
      throw new MarketplaceServiceError(
        409,
        "The seller no longer owns this NFT.",
        "ORDER_CHANGED",
        false,
      );
    const raw = await requestOpenSeaFulfillment(
      input.orderHash,
      input.tokenId,
      input.buyer as Address,
    );
    let transaction: ReturnType<typeof encodeOpenSeaFulfillment>;
    try {
      transaction = encodeOpenSeaFulfillment(raw, {
        offer: order.offer,
        tokenId: input.tokenId,
        buyer: input.buyer as Address,
      });
    } catch {
      throw new MarketplaceServiceError(
        502,
        "The provider returned an unsupported or inconsistent transaction.",
        "INVALID_FULFILLMENT",
        false,
      );
    }
    await marketplaceClient
      .call({ account: input.buyer as Address, ...transaction })
      .catch((error: unknown) => {
        throw marketplaceSimulationError(error);
      });
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
    throw new MarketplaceServiceError(
      409,
      "The listing does not match the selected NFT.",
      "ORDER_CHANGED",
      false,
    );
  }
  if (offer.priceWei !== input.expectedPriceWei)
    throw new MarketplaceServiceError(
      409,
      "The listing price changed. Refresh before purchasing.",
      "ORDER_CHANGED",
      false,
    );
  if (offer.seller.toLowerCase() === input.buyer.toLowerCase())
    throw new MarketplaceServiceError(
      409,
      "You already own this NFT.",
      "ORDER_ALREADY_OWNED",
      false,
    );
  try {
    await validateListingOnchain(marketplaceClient, listing, { requireApproval: true });
  } catch (error) {
    if (
      error instanceof Error &&
      /^Listing is (cancelled|filled|expired|invalid-owner|invalid-counter|unapproved)$/.test(
        error.message,
      )
    )
      throw new MarketplaceServiceError(
        409,
        "The listing changed or is no longer active. Refresh before purchasing.",
        "ORDER_CHANGED",
        false,
      );
    throw error;
  }
  const transaction = getListingFulfillment(listing);
  // Simulate the exact value/calldata for this buyer after revalidating the order.
  await marketplaceClient
    .call({ account: input.buyer as Address, ...transaction })
    .catch((error: unknown) => {
      throw marketplaceSimulationError(error);
    });
  return {
    offer,
    transaction: { chainId: 8453, ...transaction, value: transaction.value.toString() },
  };
}
