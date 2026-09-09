import type { Address } from "viem";
import { DAO_ADDRESSES, getConfiguredGnarsMarketplaceAddress } from "@/lib/config";
import { compareSweepOffers } from "@/lib/marketplace/mixed-sweep";
import { SEAPORT_ADDRESS } from "@/lib/marketplace/routing";
import type { MarketplaceItem, MarketplaceOffer } from "@/types/marketplace";

export type MarketplaceSweepSelection = { item: MarketplaceItem; offer: MarketplaceOffer };

export function ownSweepListings(
  inventory: MarketplaceItem[],
  buyer?: Address,
  now = Date.now(),
): MarketplaceSweepSelection[] {
  if (!buyer) return [];
  return inventory.flatMap((item) => {
    const offer = selectableSweepOffer(
      {
        ...item,
        offers: item.offers.filter((offer) => offer.seller.toLowerCase() === buyer.toLowerCase()),
      },
      undefined,
      now,
    );
    return offer ? [{ item, offer }] : [];
  });
}

export function selectableSweepOffer(item: MarketplaceItem, buyer?: Address, now = Date.now()) {
  const protocol = getConfiguredGnarsMarketplaceAddress()?.toLowerCase();
  if (
    item.collectionAddress &&
    item.collectionAddress.toLowerCase() !== DAO_ADDRESSES.token.toLowerCase()
  )
    return undefined;
  if (buyer && item.owner?.toLowerCase() === buyer.toLowerCase()) return undefined;
  return item.offers
    .filter(
      (offer) =>
        ((offer.source === "gnars-contract" && offer.protocolAddress.toLowerCase() === protocol) ||
          (offer.source === "opensea" &&
            offer.protocolAddress.toLowerCase() === SEAPORT_ADDRESS.toLowerCase())) &&
        offer.currency === "ETH" &&
        offer.expiresAt * 1000 > now &&
        offer.seller.toLowerCase() !== buyer?.toLowerCase(),
    )
    .sort(compareSweepOffers)[0];
}

export function toggleSweepSelection(
  current: MarketplaceSweepSelection[],
  selected: MarketplaceSweepSelection,
) {
  if (current.some(({ item }) => item.tokenId === selected.item.tokenId))
    return current.filter(({ item }) => item.tokenId !== selected.item.tokenId);
  return current.length < 10 ? [...current, selected] : current;
}
