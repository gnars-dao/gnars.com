import { describe, expect, it } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import type { MarketplaceItem } from "@/types/marketplace";
import { mergeMarketplaceItems } from "./merge-items";

const item: MarketplaceItem = {
  tokenId: "1",
  collectionAddress: "0x4444444444444444444444444444444444444444",
  name: "Latest name",
  image: null,
  owner: null,
  offers: [
    {
      id: "1",
      source: "gnars-contract",
      protocolAddress: "0x1111111111111111111111111111111111111111",
      orderHash: `0x${"ab".repeat(32)}`,
      seller: "0x2222222222222222222222222222222222222222",
      priceWei: "100",
      currency: "ETH",
      expiresAt: 2000000000,
      listingComment: "Latest comment",
    },
  ],
};

describe("mergeMarketplaceItems", () => {
  it("normalizes implicit and explicit Gnars collection identity", () => {
    expect(
      mergeMarketplaceItems([
        { ...item, collectionAddress: undefined },
        { ...item, collectionAddress: DAO_ADDRESSES.token },
      ]),
    ).toHaveLength(1);
  });
  it("preserves newest metadata and both offers across pages without mutating input", () => {
    const older = {
      ...item,
      name: "Old name",
      offers: [
        {
          ...item.offers[0],
          orderHash: `0x${"cd".repeat(32)}` as const,
          priceWei: "200",
          listingComment: "Old comment",
        },
      ],
    };
    const merged = mergeMarketplaceItems([item, older]);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe("Latest name");
    expect(merged[0].offers.map((offer) => offer.priceWei)).toEqual(["100", "200"]);
    expect(merged[0].offers[0].listingComment).toBe("Latest comment");
    expect(item.offers).toHaveLength(1);
  });
  it("deduplicates repeated offers case-insensitively but separates venues", () => {
    const repeat = {
      ...item,
      offers: [
        { ...item.offers[0], orderHash: `0x${"AB".repeat(32)}` as const, listingComment: "Stale" },
      ],
    };
    const otherVenue = { ...item, offers: [{ ...item.offers[0], source: "opensea" as const }] };
    const merged = mergeMarketplaceItems([item, repeat, otherVenue]);
    expect(merged[0].offers).toHaveLength(2);
    expect(merged[0].offers[0].listingComment).toBe("Latest comment");
  });
  it("keeps identical token IDs from different collections separate", () => {
    expect(
      mergeMarketplaceItems([
        item,
        { ...item, collectionAddress: "0x5555555555555555555555555555555555555555" },
      ]),
    ).toHaveLength(2);
    expect(mergeMarketplaceItems([])).toEqual([]);
  });
});
