import { formatEther, isAddressEqual, type Address, type PublicClient } from "viem";
import { communityListingCommentSchema } from "./community-comment";
import { getCommunityFeeWei, validateCommunityFeePolicy } from "./community-policy";
import { MarketplaceApiError } from "./errors";
import {
  assertMarketplaceJournalProtocol,
  buildCommunityListingQuote,
  listingSource,
  savedListingOutcome,
} from "./listing-intent";
import { getMarketplaceProtocolAddress } from "./routing";
import {
  getListingOrderHash,
  getListingPriceWei,
  seaportAbi,
  validateListingStructure,
  type ListingSourceOptions,
  type SignedListing,
} from "./seaport";

export function marketplaceActionError(reason: unknown, fallbackCode = "invalid") {
  return {
    code: reason instanceof MarketplaceApiError ? reason.code : fallbackCode,
    message: reason instanceof Error ? reason.message : "Marketplace action failed",
    ...(reason instanceof MarketplaceApiError
      ? { retryable: reason.retryable, requestId: reason.requestId }
      : {}),
  };
}

export function canRetryMarketplacePublication(attempt: {
  error?: { retryable?: boolean };
}): boolean {
  return attempt.error?.retryable !== false;
}

/** Status inspection cannot publish or request a wallet signature. */
export async function inspectSavedMarketplaceListing(
  client: Pick<PublicClient, "readContract" | "getBlock">,
  listing: SignedListing,
  options: ListingSourceOptions = {},
) {
  const status = await client.readContract({
    address: getMarketplaceProtocolAddress(options.source),
    abi: seaportAbi,
    functionName: "getOrderStatus",
    args: [getListingOrderHash(listing.parameters)],
  });
  if (status[1] || status[2] > 0n)
    return savedListingOutcome(status, listing.parameters.endTime, 0n);
  return savedListingOutcome(
    status,
    listing.parameters.endTime,
    (await client.getBlock()).timestamp,
  );
}

export function canResumeMarketplacePreflight(
  attempt: {
    phase: string;
    txHash?: unknown;
    transactionIntent?: unknown;
  } | null,
): boolean {
  return Boolean(
    attempt &&
      ["approving", "buying", "cancelling"].includes(attempt.phase) &&
      !attempt.txHash &&
      !attempt.transactionIntent,
  );
}

/** Repair metadata only. Never drop a potentially broadcast transaction or unknown signature. */
export function repairMarketplaceJournal(raw: string, account: Address): string {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || !isAddressEqual(value.account, account))
    throw new Error("Saved attempt does not match this wallet");
  if (value.txHash || value.transactionIntent)
    throw new Error("Export the saved attempt: transaction details require reconciliation");
  if (!value.listing)
    throw new Error("Export the saved attempt: an unresolved signature cannot be safely discarded");
  const source = listingSource(value.input ?? { source: value.offer?.source });
  assertMarketplaceJournalProtocol({ kind: "list", input: { ...value.input, source } });
  const collectionAddress = value.input?.collectionAddress ?? value.offer?.collectionAddress;
  const listingComment =
    value.input?.listingComment === undefined
      ? undefined
      : communityListingCommentSchema.parse(value.input.listingComment);
  if (listingComment !== undefined && (!collectionAddress || source !== "gnars-contract"))
    throw new Error("Comments require a community listing");
  const savedFeePolicy = value.input?.expectedQuote?.feePolicy ?? value.offer?.feePolicy;
  const feePolicy =
    collectionAddress || savedFeePolicy !== undefined
      ? validateCommunityFeePolicy(savedFeePolicy)
      : undefined;
  const listing = validateListingStructure(value.listing, {
    source,
    collectionAddress,
    feePolicy,
    allowExpired: true,
  });
  if (!isAddressEqual(listing.parameters.offerer, account))
    throw new Error("Saved order does not match this wallet");
  const tokenId = listing.parameters.offer[0].identifierOrCriteria;
  const priceWei = getListingPriceWei(listing);
  const royalty = feePolicy
    ? listing.parameters.consideration[getCommunityFeeWei(priceWei, feePolicy) > 0n ? 2 : 1]
    : undefined;
  const expectedQuote = feePolicy
    ? {
        ...buildCommunityListingQuote(
          priceWei.toString(),
          {
            amount: royalty ? BigInt(royalty.startAmount) : 0n,
            recipient: royalty?.recipient ?? account,
          },
          feePolicy,
        ),
        source,
      }
    : undefined;
  return JSON.stringify({
    version: 1,
    account,
    id: typeof value.id === "string" && value.id ? value.id : crypto.randomUUID(),
    kind: "list",
    phase: "saving",
    tokenId,
    ...(collectionAddress ? { collectionAddress } : {}),
    listing,
    input: {
      ...(listingComment !== undefined ? { listingComment } : {}),
      tokenId,
      source,
      ...(collectionAddress ? { collectionAddress } : {}),
      ...(expectedQuote ? { expectedQuote } : {}),
      ...(source === "gnars-contract" ? { protocolAddress: value.input.protocolAddress } : {}),
      priceEth: formatEther(priceWei),
      durationDays: Math.max(
        1,
        Math.min(
          30,
          Math.floor(
            (Number(listing.parameters.endTime) - Number(listing.parameters.startTime)) / 86400,
          ),
        ),
      ),
    },
    signatureRequestSettled: true,
  });
}
