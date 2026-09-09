import { isAddress, isAddressEqual, type Address } from "viem";
import { z } from "zod";
import type { MarketplaceOffer, MarketplaceSource } from "@/types/marketplace";
import { buildOpenSeaListingQuote, type OpenSeaListingQuote } from "./opensea-listing";
import { getMarketplaceProtocolAddress } from "./routing";
import { getListingOrderHash, getListingPriceWei, type SignedListing } from "./seaport";

export type MarketplaceListingQuote = OpenSeaListingQuote & {
  source: MarketplaceSource;
  royaltyWei: string;
  royaltyRecipient: Address | null;
};

export function canCancelSavedListing(
  attempt: {
    kind: string;
    phase: string;
    listing?: unknown;
    txHash?: unknown;
    transactionIntent?: unknown;
    transactionFailed?: boolean;
  } | null,
): boolean {
  return Boolean(
    attempt &&
      ((attempt.kind === "list" && attempt.phase === "saving") ||
        (attempt.kind === "cancel" && attempt.phase === "failed")) &&
      attempt.listing &&
      ((!attempt.txHash && !attempt.transactionIntent) || attempt.transactionFailed === true),
  );
}

export function savedListingOutcome(
  status: readonly [boolean, boolean, bigint, bigint],
  endTime: string,
  chainTimestamp: bigint,
): "filled" | "cancelled" | "expired" | null {
  if (status[1]) return "cancelled";
  if (status[2] > 0n) return "filled";
  return BigInt(endTime) <= chainTimestamp ? "expired" : null;
}

// Missing source belongs to the pre-OpenSea journal format, never a new default destination.
export function listingSource(input?: { source?: unknown }): MarketplaceSource {
  const source = input?.source ?? "gnars";
  if (source !== "gnars" && source !== "opensea" && source !== "gnars-contract")
    throw new Error("Invalid listing destination");
  return source;
}

/** A signed order's domain cannot follow a later deployment configuration change. */
export function assertMarketplaceJournalProtocol(attempt: {
  kind?: string;
  input?: { source?: unknown; protocolAddress?: unknown };
  offer?: { source?: unknown; protocolAddress?: unknown };
}): void {
  const identity = attempt.kind === "list" ? attempt.input : attempt.offer;
  if (listingSource(identity) !== "gnars-contract") return;
  const protocol = identity?.protocolAddress;
  if (
    typeof protocol !== "string" ||
    !isAddress(protocol, { strict: false }) ||
    !isAddressEqual(protocol, getMarketplaceProtocolAddress("gnars-contract"))
  )
    throw new Error("Saved listing protocol does not match the configured Gnars contract");
}

export function parseOpenSeaQuote(raw: unknown, priceWei: string): MarketplaceListingQuote {
  const address = z
    .string()
    .regex(/^0x[\da-fA-F]{40}$/)
    .transform((v) => v as Address);
  const uint = z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .max(78);
  const quote = z
    .object({
      priceWei: uint,
      sellerWei: uint,
      fees: z
        .array(
          z
            .object({
              recipient: address,
              basisPoints: z.number().int().min(0).max(9999),
              amountWei: uint,
            })
            .strict(),
        )
        .max(9),
    })
    .strict()
    .parse(raw);
  const expected = buildOpenSeaListingQuote(
    priceWei,
    quote.fees.map(({ recipient, basisPoints }) => ({ recipient, basisPoints })),
  );
  if (
    quote.priceWei !== priceWei ||
    quote.sellerWei !== expected.sellerWei ||
    quote.fees.some((fee, index) => fee.amountWei !== expected.fees[index].amountWei)
  )
    throw new Error("Invalid OpenSea fee quote");
  return { ...expected, source: "opensea", royaltyWei: "0", royaltyRecipient: null };
}

export function sameListingQuote(a: MarketplaceListingQuote, b: MarketplaceListingQuote): boolean {
  return (
    a.source === b.source &&
    a.priceWei === b.priceWei &&
    a.sellerWei === b.sellerWei &&
    a.royaltyWei === b.royaltyWei &&
    a.royaltyRecipient?.toLowerCase() === b.royaltyRecipient?.toLowerCase() &&
    a.fees.length === b.fees.length &&
    a.fees.every((fee, index) => {
      const other = b.fees[index];
      return (
        isAddressEqual(fee.recipient, other.recipient) &&
        fee.basisPoints === other.basisPoints &&
        fee.amountWei === other.amountWei
      );
    })
  );
}

export function assertPublishedListing(
  offer: MarketplaceOffer,
  listing: SignedListing,
  source: MarketplaceSource,
) {
  if (
    offer.source !== source ||
    offer.currency !== "ETH" ||
    !isAddressEqual(offer.protocolAddress, getMarketplaceProtocolAddress(source)) ||
    offer.orderHash.toLowerCase() !== getListingOrderHash(listing.parameters).toLowerCase() ||
    !isAddressEqual(offer.seller, listing.parameters.offerer) ||
    offer.priceWei !== getListingPriceWei(listing).toString() ||
    offer.expiresAt !== Number(listing.parameters.endTime)
  )
    throw new Error("Publication does not match the signed listing");
}
