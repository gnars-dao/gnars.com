import "server-only";
import { decodeFunctionResult, type Address, type Hex } from "viem";
import { z } from "zod";
import { getMarketplaceProtocolAddress } from "@/lib/marketplace/routing";
import {
  getListingOrderHash,
  getListingPriceWei,
  validateListingOnchain,
  type SignedListing,
} from "@/lib/marketplace/seaport";
import {
  getSweepFulfillment,
  MAX_SWEEP_ITEMS,
  sweepAbi,
  type SweepQuote,
  type SweepSelection,
} from "@/lib/marketplace/sweep";
import { getMarketplaceMetadata } from "./marketplace-catalogue";
import {
  marketplaceAddressSchema,
  marketplaceClient,
  marketplaceHashSchema,
  MarketplaceServiceError,
  marketplaceSimulationError,
  marketplaceUintSchema,
  marketplaceUnavailable,
} from "./marketplace-common";
import {
  getMarketplaceOrder,
  getMarketplaceSweepCandidates,
  localMarketplaceOffer,
} from "./marketplace-orders";

const selectionSchema = z
  .object({
    orderHash: marketplaceHashSchema.transform((value) => value as Hex),
    tokenId: marketplaceUintSchema,
    priceWei: marketplaceUintSchema,
  })
  .strict();
const selectionsSchema = z
  .array(selectionSchema)
  .min(1)
  .max(MAX_SWEEP_ITEMS)
  .refine(
    (items) =>
      new Set(items.map((item) => item.tokenId)).size === items.length &&
      new Set(items.map((item) => item.orderHash.toLowerCase())).size === items.length,
  );
export const sweepQuoteSchema = z
  .object({
    buyer: marketplaceAddressSchema,
    quantity: z.number().int().min(1).max(MAX_SWEEP_ITEMS),
    maxPriceWei: marketplaceUintSchema.optional(),
    selections: selectionsSchema.optional(),
  })
  .strict()
  .refine((input) => !input.selections || input.selections.length === input.quantity);
export const sweepFulfillmentSchema = z
  .object({
    buyer: marketplaceAddressSchema,
    selections: selectionsSchema,
    maxTotalWei: marketplaceUintSchema,
  })
  .strict();

function changed() {
  return new MarketplaceServiceError(
    409,
    "The selected floor listings changed. Review the sweep again.",
    "ORDER_CHANGED",
    false,
  );
}
function inactive(error: unknown) {
  return (
    error instanceof Error &&
    /^Listing (?:is (?:cancelled|filled|expired|invalid-owner|invalid-counter|unapproved)|expired)$/.test(
      error.message,
    )
  );
}
async function validate(listing: SignedListing, buyer: string) {
  if (listing.parameters.offerer.toLowerCase() === buyer.toLowerCase()) throw changed();
  return validateListingOnchain(marketplaceClient, listing, {
    source: "gnars-contract",
    requireApproval: true,
  });
}
async function exactListings(buyer: string, selections: SweepSelection[]) {
  const listings: SignedListing[] = [];
  for (const selection of selections) {
    const listing = await getMarketplaceOrder(selection.orderHash, "gnars-contract");
    if (
      getListingOrderHash(listing.parameters).toLowerCase() !== selection.orderHash.toLowerCase() ||
      listing.parameters.offer[0].identifierOrCriteria !== selection.tokenId ||
      getListingPriceWei(listing).toString() !== selection.priceWei
    )
      throw changed();
    try {
      await validate(listing, buyer);
    } catch (error) {
      if (inactive(error)) throw changed();
      throw error;
    }
    listings.push(listing);
  }
  getSweepFulfillment(listings);
  return listings;
}

export async function quoteMarketplaceSweep(
  input: z.infer<typeof sweepQuoteSchema>,
): Promise<SweepQuote> {
  let listings: SignedListing[];
  if (input.selections) {
    listings = await exactListings(input.buyer, input.selections);
  } else {
    const { candidates, truncated } = await getMarketplaceSweepCandidates(
      input.buyer as Address,
      input.maxPriceWei,
    );
    listings = [];
    const tokens = new Set<string>();
    for (const listing of candidates) {
      const token = listing.parameters.offer[0].identifierOrCriteria;
      if (
        tokens.has(token) ||
        listing.parameters.offerer.toLowerCase() === input.buyer.toLowerCase()
      )
        continue;
      try {
        await validate(listing, input.buyer);
      } catch (error) {
        if (inactive(error)) continue;
        throw error;
      }
      tokens.add(token);
      listings.push(listing);
      if (listings.length === input.quantity) break;
    }
    if (listings.length < input.quantity && truncated)
      throw marketplaceUnavailable(
        "The floor could not be verified within the request budget. Try a smaller quantity.",
      );
    if (!listings.length)
      throw new MarketplaceServiceError(
        409,
        "No available floor listings match this selection.",
        "SWEEP_EMPTY",
        false,
      );
  }
  if (
    input.maxPriceWei !== undefined &&
    listings.some((listing) => getListingPriceWei(listing) > BigInt(input.maxPriceWei!))
  )
    throw changed();
  const { value } = getSweepFulfillment(listings);
  const metadata = await getMarketplaceMetadata(
    listings.map((listing) => listing.parameters.offer[0].identifierOrCriteria),
  );
  return {
    listings,
    items: listings.map((listing) => {
      const tokenId = listing.parameters.offer[0].identifierOrCriteria;
      const item = metadata.find((item) => item.tokenId === tokenId);
      return {
        tokenId,
        name: item?.name ?? `Gnar #${tokenId}`,
        image: item?.image ?? null,
        owner: listing.parameters.offerer,
        offers: [localMarketplaceOffer(listing, "gnars-contract")],
      };
    }),
    totalWei: value.toString(),
    expiresAt: Math.min(
      Math.floor(Date.now() / 1000) + 90,
      ...listings.map((listing) => Number(listing.parameters.endTime)),
    ),
    protocolAddress: getMarketplaceProtocolAddress("gnars-contract"),
  };
}

export async function prepareMarketplaceSweep(input: z.infer<typeof sweepFulfillmentSchema>) {
  const listings = await exactListings(input.buyer, input.selections);
  const transaction = getSweepFulfillment(listings);
  if (transaction.value > BigInt(input.maxTotalWei)) throw changed();
  let result;
  try {
    result = await marketplaceClient.call({ account: input.buyer as Address, ...transaction });
  } catch (error) {
    throw marketplaceSimulationError(error);
  }
  if (!result.data) throw marketplaceUnavailable("The sweep simulation result is unavailable.");
  const [available] = decodeFunctionResult({
    abi: sweepAbi,
    functionName: "fulfillAvailableOrders",
    data: result.data,
  });
  if (available.length !== listings.length || available.some((value) => !value)) throw changed();
  return {
    listings,
    transaction: { chainId: 8453 as const, ...transaction, value: transaction.value.toString() },
    totalWei: transaction.value.toString(),
  };
}
