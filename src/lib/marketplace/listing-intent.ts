import { isAddress, isAddressEqual, type Address } from "viem";
import { z } from "zod";
import type { MarketplaceOffer, MarketplaceSource } from "@/types/marketplace";
import {
  getCommunityFeeWei,
  GNARS_MARKETPLACE_FEE_POLICY,
  marketplaceCollectionAddress,
  validateCommunityFeePolicy,
  type CommunityFeePolicy,
} from "./community-policy";
import { buildOpenSeaListingQuote, type OpenSeaListingQuote } from "./opensea-listing";
import { getMarketplaceProtocolAddress } from "./routing";
import { getListingOrderHash, getListingPriceWei, type SignedListing } from "./seaport";

export type MarketplaceListingQuote = OpenSeaListingQuote & {
  source: MarketplaceSource;
  royaltyWei: string;
  royaltyRecipient: Address | null;
  feePolicy?: CommunityFeePolicy;
};

export function buildNativeListingQuote(
  priceWei: string,
  royalty: { amount: bigint; recipient: Address },
  source: "gnars" | "gnars-contract",
): MarketplaceListingQuote {
  if (source !== "gnars" && source !== "gnars-contract")
    throw new Error("Native listing quote requires a Gnars source");
  return { ...buildCommunityListingQuote(priceWei, royalty, GNARS_MARKETPLACE_FEE_POLICY), source };
}

export function buildCommunityListingQuote(
  priceWei: string,
  royalty: { amount: bigint; recipient: Address },
  rawPolicy: CommunityFeePolicy,
): MarketplaceListingQuote {
  if (!/^(0|[1-9]\d*)$/.test(priceWei)) throw new Error("Invalid listing price");
  const price = BigInt(priceWei);
  const feePolicy = validateCommunityFeePolicy(rawPolicy);
  const fee = getCommunityFeeWei(price, feePolicy);
  if (
    royalty.amount < 0n ||
    fee + royalty.amount >= price ||
    (royalty.amount > 0n &&
      (!isAddress(royalty.recipient, { strict: false }) || /^0x0{40}$/i.test(royalty.recipient)))
  )
    throw new Error("Invalid royalty or marketplace fee total");
  return {
    source: "gnars-contract",
    priceWei,
    sellerWei: (price - fee - royalty.amount).toString(),
    royaltyWei: royalty.amount.toString(),
    royaltyRecipient: royalty.amount ? royalty.recipient : null,
    fees:
      fee > 0n
        ? [
            {
              recipient: feePolicy.recipient,
              basisPoints: feePolicy.basisPoints,
              amountWei: fee.toString(),
            },
          ]
        : [],
    feePolicy,
  };
}

/** Rebuild server quotes locally, using a separately observed collection royalty. */
export function parseCommunityQuote(
  raw: unknown,
  priceWei: string,
  royalty: { amount: bigint; recipient: Address },
): MarketplaceListingQuote {
  const policy = validateCommunityFeePolicy((raw as { feePolicy?: unknown } | null)?.feePolicy);
  const expected = buildCommunityListingQuote(priceWei, royalty, policy);
  if (
    !raw ||
    typeof raw !== "object" ||
    !sameListingQuote(raw as MarketplaceListingQuote, expected)
  )
    throw new Error("Invalid community fee quote");
  return expected;
}

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
    Array.isArray(a.fees) &&
    Array.isArray(b.fees) &&
    a.source === b.source &&
    a.priceWei === b.priceWei &&
    a.sellerWei === b.sellerWei &&
    a.royaltyWei === b.royaltyWei &&
    a.royaltyRecipient?.toLowerCase() === b.royaltyRecipient?.toLowerCase() &&
    a.feePolicy?.basisPoints === b.feePolicy?.basisPoints &&
    a.feePolicy?.recipient?.toLowerCase() === b.feePolicy?.recipient?.toLowerCase() &&
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
    offer.expiresAt !== Number(listing.parameters.endTime) ||
    !isAddressEqual(
      marketplaceCollectionAddress(offer.collectionAddress),
      listing.parameters.offer[0].token,
    )
  )
    throw new Error("Publication does not match the signed listing");
}
