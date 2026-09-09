import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import type { MarketplaceItem, MarketplaceOffer } from "@/types/marketplace";
import { selectableSweepOffer, toggleSweepSelection } from "./marketplace-sweep-model";

const protocol = "0x1111111111111111111111111111111111111111";
const seller = "0x2222222222222222222222222222222222222222";
const buyer = "0x3333333333333333333333333333333333333333";
const offer: MarketplaceOffer = {
  id: "own",
  source: "gnars-contract",
  protocolAddress: protocol,
  orderHash: `0x${"01".repeat(32)}`,
  seller,
  priceWei: "100",
  currency: "ETH",
  expiresAt: 200,
};
const item: MarketplaceItem = {
  tokenId: "42",
  name: "Gnar #42",
  image: null,
  owner: seller,
  offers: [offer],
};

describe("sweep selection", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", protocol));
  afterEach(() => vi.unstubAllEnvs());
  it("selects the cheapest eligible custom order, not a cheaper OpenSea or canonical order", () => {
    const offers: MarketplaceOffer[] = [
      { ...offer, priceWei: "1", source: "opensea" },
      { ...offer, priceWei: "2", source: "gnars" },
      { ...offer, priceWei: "3", protocolAddress: seller },
      { ...offer, priceWei: "50" },
      offer,
    ];
    expect(selectableSweepOffer({ ...item, offers }, buyer, 100_000)?.priceWei).toBe("50");
  });
  it("excludes both owned NFTs and self-sold orders for the actual write account", () => {
    expect(selectableSweepOffer(item, seller, 100_000)).toBeUndefined();
    expect(selectableSweepOffer({ ...item, owner: buyer }, buyer, 100_000)).toBeUndefined();
    expect(selectableSweepOffer({ ...item, owner: null }, buyer, 100_000)).toEqual(offer);
  });
  it("excludes expired orders and community collections", () => {
    expect(selectableSweepOffer(item, buyer, 200_000)).toBeUndefined();
    expect(
      selectableSweepOffer({ ...item, collectionAddress: seller }, buyer, 100_000),
    ).toBeUndefined();
    expect(
      selectableSweepOffer({ ...item, collectionAddress: DAO_ADDRESSES.token }, buyer, 100_000),
    ).toEqual(offer);
  });
  it("fails closed without a configured custom protocol", () => {
    vi.stubEnv("NEXT_PUBLIC_GNARS_MARKETPLACE_ADDRESS", "");
    expect(selectableSweepOffer(item, buyer, 100_000)).toBeUndefined();
  });
  it("toggles by NFT identity rather than allowing two orders for the same NFT", () => {
    const first = toggleSweepSelection([], { item, offer });
    expect(first).toHaveLength(1);
    expect(
      toggleSweepSelection(first, { item, offer: { ...offer, orderHash: `0x${"02".repeat(32)}` } }),
    ).toEqual([]);
  });
  it("caps manual selection at ten without evicting the first selection", () => {
    const current = Array.from({ length: 10 }, (_, index) => ({
      item: { ...item, tokenId: String(index) },
      offer,
    }));
    expect(toggleSweepSelection(current, { item, offer })).toBe(current);
    expect(toggleSweepSelection(current, current[3])).toHaveLength(9);
  });
});
