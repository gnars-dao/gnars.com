import type { MarketplaceItem, MarketplaceOffer } from "@/types/marketplace";

export function isCurrentMarketplaceOffer(
  item: MarketplaceItem,
  selected: MarketplaceOffer | null,
  now: number,
): boolean {
  if (!selected || selected.expiresAt * 1000 <= now) return false;
  if (item.owner?.toLowerCase() !== selected.seller.toLowerCase()) return false;
  return item.offers.some(
    (offer) =>
      offer.source === selected.source &&
      offer.protocolAddress.toLowerCase() === selected.protocolAddress.toLowerCase() &&
      offer.orderHash.toLowerCase() === selected.orderHash.toLowerCase() &&
      offer.seller.toLowerCase() === selected.seller.toLowerCase() &&
      offer.priceWei === selected.priceWei &&
      offer.currency === selected.currency &&
      offer.expiresAt === selected.expiresAt,
  );
}
