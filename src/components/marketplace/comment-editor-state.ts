import type { MarketplaceOffer } from "@/types/marketplace";

export function commentRevision(offer: MarketplaceOffer): number {
  return offer.listingCommentRevision ?? 0;
}

export function readCommentOffer(value: unknown, previous: MarketplaceOffer): MarketplaceOffer {
  if (!value || typeof value !== "object" || !("offer" in value))
    throw new Error("Missing comment response");
  const next = value.offer as Partial<MarketplaceOffer> | null;
  if (
    !next ||
    next.orderHash?.toLowerCase() !== previous.orderHash.toLowerCase() ||
    next.protocolAddress?.toLowerCase() !== previous.protocolAddress.toLowerCase() ||
    next.seller?.toLowerCase() !== previous.seller.toLowerCase() ||
    next.collectionAddress?.toLowerCase() !== previous.collectionAddress?.toLowerCase() ||
    next.source !== "gnars-contract" ||
    !Number.isSafeInteger(next.listingCommentRevision) ||
    next.listingCommentRevision! < commentRevision(previous) ||
    (next.listingComment !== undefined &&
      (typeof next.listingComment !== "string" || next.listingComment.length > 280))
  )
    throw new Error("Invalid comment response");
  return {
    ...previous,
    listingComment: next.listingComment,
    listingCommentRevision: next.listingCommentRevision,
  };
}

/** Patch only comment fields in the marketplace's page and infinite-page caches. */
export function updateCachedComment(value: unknown, offer: MarketplaceOffer): unknown {
  if (!value || typeof value !== "object") return value;
  if ("pages" in value && Array.isArray(value.pages))
    return { ...value, pages: value.pages.map((page) => updateCachedComment(page, offer)) };
  if ("items" in value && Array.isArray(value.items))
    return { ...value, items: value.items.map((item) => updateCachedComment(item, offer)) };
  if ("offers" in value && Array.isArray(value.offers))
    return {
      ...value,
      offers: value.offers.map((existing: MarketplaceOffer) =>
        existing.orderHash.toLowerCase() === offer.orderHash.toLowerCase() &&
        existing.protocolAddress.toLowerCase() === offer.protocolAddress.toLowerCase() &&
        commentRevision(existing) <= commentRevision(offer)
          ? {
              ...existing,
              listingComment: offer.listingComment,
              listingCommentRevision: offer.listingCommentRevision,
            }
          : existing,
      ),
    };
  return value;
}
