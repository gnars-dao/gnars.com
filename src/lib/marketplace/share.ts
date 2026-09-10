import { isAddress, type Address, type Hex } from "viem";
import { DAO_ADDRESSES } from "@/lib/config";
import type { MarketplaceSource } from "@/types/marketplace";

// This is the domain in the signed Farcaster account association.
export const MARKETPLACE_SHARE_ORIGIN = "https://gnars.com";
export type MarketplaceShareTarget = {
  tokenId: string;
  collectionAddress?: Address;
  orderHash?: Hex;
  source?: MarketplaceSource;
  locale?: string;
};
type Search = Record<string, string | string[] | undefined>;

export function parseMarketplaceShareQuery(query: Search): MarketplaceShareTarget | null {
  const { nft, collection, order, source } = query;
  if (typeof nft !== "string" || !/^\d{1,78}$/.test(nft) || BigInt(nft) >= 2n ** 256n) return null;
  if (
    collection !== undefined &&
    (typeof collection !== "string" || !isAddress(collection, { strict: false }))
  )
    return null;
  if (order !== undefined && (typeof order !== "string" || !/^0x[0-9a-f]{64}$/i.test(order)))
    return null;
  if (source !== undefined && !["gnars", "gnars-contract", "opensea"].includes(source as string))
    return null;
  if ((order === undefined) !== (source === undefined)) return null;
  return {
    tokenId: BigInt(nft).toString(),
    ...(collection && collection.toLowerCase() !== DAO_ADDRESSES.token.toLowerCase()
      ? { collectionAddress: collection.toLowerCase() as Address }
      : {}),
    ...(order
      ? { orderHash: order.toLowerCase() as Hex, source: source as MarketplaceSource }
      : {}),
  };
}

export function buildMarketplaceShareUrl(target: MarketplaceShareTarget) {
  const normalized = parseMarketplaceShareQuery({
    nft: target.tokenId,
    collection: target.collectionAddress,
    order: target.orderHash,
    source: target.source,
  });
  if (!normalized) throw new Error("Invalid marketplace share target");
  const url = new URL(
    target.locale === "pt-br" ? "/pt-br/marketplace" : "/marketplace",
    MARKETPLACE_SHARE_ORIGIN,
  );
  url.searchParams.set("nft", normalized.tokenId);
  if (normalized.collectionAddress)
    url.searchParams.set("collection", normalized.collectionAddress);
  if (normalized.orderHash) {
    url.searchParams.set("order", normalized.orderHash);
    url.searchParams.set("source", normalized.source!);
  }
  return url.href;
}
