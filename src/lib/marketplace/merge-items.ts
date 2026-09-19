import { DAO_ADDRESSES } from "@/lib/config";
import type { MarketplaceItem } from "@/types/marketplace";

// Pages are newest first; retain their metadata while accumulating older offers.
export function mergeMarketplaceItems(items: MarketplaceItem[]): MarketplaceItem[] {
  const grouped = new Map<string, MarketplaceItem>();
  for (const item of items) {
    const key = `${(item.collectionAddress ?? DAO_ADDRESSES.token).toLowerCase()}:${item.tokenId}`;
    const previous = grouped.get(key);
    const offers = new Map<string, MarketplaceItem["offers"][number]>();
    for (const offer of [...(previous?.offers ?? []), ...item.offers]) {
      const identity = `${offer.source}:${offer.protocolAddress.toLowerCase()}:${offer.orderHash.toLowerCase()}`;
      if (!offers.has(identity)) offers.set(identity, offer);
    }
    grouped.set(key, { ...(previous ?? item), offers: [...offers.values()] });
  }
  return [...grouped.values()];
}
