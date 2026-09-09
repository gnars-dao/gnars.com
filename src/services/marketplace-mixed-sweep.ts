import "server-only";
import { erc721Abi, type Address } from "viem";
import { z } from "zod";
import { DAO_ADDRESSES } from "@/lib/config";
import {
  compareSweepOffers,
  mixedSweepSelectionSchema,
  validateMixedSweepPlan,
  type MixedSweepSelection,
} from "@/lib/marketplace/mixed-sweep";
import {
  getListingPriceWei,
  seaportAbi,
  validateListingOnchain,
  type SignedListing,
} from "@/lib/marketplace/seaport";
import { MAX_SWEEP_ITEMS } from "@/lib/marketplace/sweep";
import type { MarketplaceOffer } from "@/types/marketplace";
import { getMarketplaceMetadata } from "./marketplace-catalogue";
import {
  marketplaceAddressSchema,
  marketplaceClient,
  MarketplaceServiceError,
  marketplaceUintSchema,
  marketplaceUnavailable,
} from "./marketplace-common";
import { getOpenSeaMarketplaceOrder, listOpenSeaMarketplace } from "./marketplace-opensea";
import {
  getMarketplaceOrder,
  getMarketplaceSweepCandidates,
  localMarketplaceOffer,
} from "./marketplace-orders";

export const mixedSweepQuoteSchema = z
  .object({
    buyer: marketplaceAddressSchema,
    quantity: z.number().int().min(1).max(MAX_SWEEP_ITEMS),
    maxPriceWei: marketplaceUintSchema.optional(),
    selections: z.array(mixedSweepSelectionSchema).min(1).max(MAX_SWEEP_ITEMS).optional(),
  })
  .strict()
  .refine(
    (input) =>
      !input.selections ||
      (input.selections.length === input.quantity &&
        new Set(input.selections.map((s) => s.tokenId)).size === input.quantity),
  );

type Candidate = { tokenId: string; offer: MarketplaceOffer; listing?: SignedListing };
const changed = () =>
  new MarketplaceServiceError(
    409,
    "The selected listings changed. Review the sweep again.",
    "ORDER_CHANGED",
    false,
  );
const unavailable = () =>
  marketplaceUnavailable("The combined floor could not be verified within the request budget.");

async function active(candidate: Candidate, buyer: Address): Promise<boolean> {
  if (candidate.offer.expiresAt <= Math.floor(Date.now() / 1000)) return false;
  if (candidate.offer.seller.toLowerCase() === buyer.toLowerCase()) return false;
  if (candidate.listing) {
    try {
      await validateListingOnchain(marketplaceClient, candidate.listing, {
        source: "gnars-contract",
        requireApproval: true,
      });
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        /^Listing (?:is (?:cancelled|filled|expired|invalid-owner|invalid-counter|unapproved)|expired)$/.test(
          error.message,
        )
      )
        return false;
      throw error;
    }
  }
  const owner = await marketplaceClient.readContract({
    address: DAO_ADDRESSES.token,
    abi: erc721Abi,
    functionName: "ownerOf",
    args: [BigInt(candidate.tokenId)],
  });
  if (owner.toLowerCase() !== candidate.offer.seller.toLowerCase()) return false;
  const [, cancelled, filled, size] = await marketplaceClient.readContract({
    address: candidate.offer.protocolAddress,
    abi: seaportAbi,
    functionName: "getOrderStatus",
    args: [candidate.offer.orderHash],
  });
  return !cancelled && !(size > 0n && filled >= size);
}

async function exact(selection: MixedSweepSelection): Promise<Candidate> {
  let row: Candidate;
  if (selection.source === "opensea") row = await getOpenSeaMarketplaceOrder(selection.orderHash);
  else {
    const listing = await getMarketplaceOrder(selection.orderHash, "gnars-contract");
    row = {
      listing,
      tokenId: listing.parameters.offer[0].identifierOrCriteria,
      offer: localMarketplaceOffer(listing, "gnars-contract"),
    };
  }
  if (
    row.tokenId !== selection.tokenId ||
    row.offer.priceWei !== selection.priceWei ||
    row.offer.orderHash.toLowerCase() !== selection.orderHash.toLowerCase()
  )
    throw changed();
  return row;
}

export async function quoteMixedMarketplaceSweep(input: z.infer<typeof mixedSweepQuoteSchema>) {
  const buyer = input.buyer as Address;
  const selected: Candidate[] = [];
  if (input.selections) {
    for (const selection of input.selections) {
      const row = await exact(selection);
      if (!(await active(row, buyer))) throw changed();
      selected.push(row);
    }
  } else {
    const native = await getMarketplaceSweepCandidates(buyer, input.maxPriceWei);
    const candidates: Candidate[] = native.candidates.map((listing) => ({
      listing,
      tokenId: listing.parameters.offer[0].identifierOrCriteria,
      offer: localMarketplaceOffer(listing, "gnars-contract"),
    }));
    // Both feeds are ascending. A frontier bounds unseen prices without scanning the collection.
    let cursor: string | undefined;
    let openSeaBoundary: bigint | null = null;
    const visited = new Set<string>();
    const eligibility = new Map<string, boolean>();
    const cutoff = () =>
      selected.length === input.quantity
        ? BigInt(selected.at(-1)!.offer.priceWei)
        : input.maxPriceWei !== undefined
          ? BigInt(input.maxPriceWei)
          : null;
    for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
      const page = await listOpenSeaMarketplace(cursor);
      if (page.partial) throw unavailable();
      candidates.push(...page.offers);
      openSeaBoundary = page.nextCursor
        ? page.offers.length
          ? page.offers.reduce(
              (max, row) => (BigInt(row.offer.priceWei) > max ? BigInt(row.offer.priceWei) : max),
              0n,
            )
          : 0n
        : null;
      selected.length = 0;
      const tokens = new Set<string>();
      for (const row of candidates.sort((a, b) => compareSweepOffers(a.offer, b.offer))) {
        if (tokens.has(row.tokenId) || row.offer.seller.toLowerCase() === buyer.toLowerCase())
          continue;
        if (
          input.maxPriceWei !== undefined &&
          BigInt(row.offer.priceWei) > BigInt(input.maxPriceWei)
        )
          break;
        const key = `${row.offer.source}:${row.offer.orderHash.toLowerCase()}`;
        if (!eligibility.has(key)) {
          if (eligibility.size >= 30) throw unavailable();
          eligibility.set(key, await active(row, buyer));
        }
        if (!eligibility.get(key)) continue;
        tokens.add(row.tokenId);
        selected.push(row);
        if (selected.length === input.quantity) break;
      }
      const price = cutoff();
      if (
        !page.nextCursor ||
        (price !== null && openSeaBoundary !== null && price <= openSeaBoundary)
      )
        break;
      if (visited.has(page.nextCursor)) throw unavailable();
      visited.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    const price = cutoff();
    const nativeBoundary = native.truncated ? getListingPriceWei(native.candidates.at(-1)!) : null;
    for (const boundary of [nativeBoundary, openSeaBoundary]) {
      if (boundary !== null && (price === null || price > boundary)) throw unavailable();
    }
  }
  if (!selected.length)
    throw new MarketplaceServiceError(409, "No eligible floor listings.", "SWEEP_EMPTY", false);
  if (
    input.maxPriceWei !== undefined &&
    selected.some((row) => BigInt(row.offer.priceWei) > BigInt(input.maxPriceWei!))
  )
    throw changed();
  const metadata = await getMarketplaceMetadata(selected.map((row) => row.tokenId));
  return validateMixedSweepPlan(
    {
      buyer,
      items: selected.map((row) => {
        const item = metadata.find((item) => item.tokenId === row.tokenId);
        return {
          tokenId: row.tokenId,
          name: item?.name ?? `Gnar #${row.tokenId}`,
          image: item?.image ?? null,
          owner: row.offer.seller,
          offers: [row.offer],
        };
      }),
      totalWei: selected.reduce((sum, row) => sum + BigInt(row.offer.priceWei), 0n).toString(),
      expiresAt: Math.min(
        Math.floor(Date.now() / 1000) + 90,
        ...selected.map((row) => row.offer.expiresAt),
      ),
    },
    buyer,
  );
}
