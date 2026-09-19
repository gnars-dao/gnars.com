import { describe, expect, it } from "vitest";
import type { MarketplaceItem, MarketplaceOffer } from "@/types/marketplace";
import { isCurrentMarketplaceOffer } from "./current-offer";

const offer: MarketplaceOffer = {
  id: "listing",
  source: "opensea",
  protocolAddress: "0x1111111111111111111111111111111111111111",
  orderHash: `0x${"ab".repeat(32)}`,
  seller: "0x2222222222222222222222222222222222222222",
  priceWei: "100",
  currency: "ETH",
  expiresAt: 2000,
};
const item: MarketplaceItem = {
  tokenId: "42",
  name: "Gnar #42",
  image: null,
  owner: offer.seller,
  offers: [offer],
};

describe("isCurrentMarketplaceOffer", () => {
  it("accepts the reviewed offer and ignores display-only comment changes", () => {
    expect(isCurrentMarketplaceOffer(item, offer, 1000)).toBe(true);
    expect(
      isCurrentMarketplaceOffer(
        { ...item, offers: [{ ...offer, listingComment: "Updated" }] },
        offer,
        1000,
      ),
    ).toBe(true);
  });
  it("rejects missing, expired, removed and transferred offers", () => {
    expect(isCurrentMarketplaceOffer(item, null, 1000)).toBe(false);
    expect(isCurrentMarketplaceOffer(item, offer, 2000000)).toBe(false);
    expect(isCurrentMarketplaceOffer({ ...item, offers: [] }, offer, 1000)).toBe(false);
    expect(isCurrentMarketplaceOffer({ ...item, owner: null }, offer, 1000)).toBe(false);
  });
  it.each([
    { source: "gnars" },
    { protocolAddress: offer.seller },
    { orderHash: `0x${"cd".repeat(32)}` },
    { seller: offer.protocolAddress },
    { priceWei: "200" },
    { expiresAt: 2001 },
  ])("rejects changed order terms %j", (change) => {
    expect(
      isCurrentMarketplaceOffer(
        { ...item, offers: [{ ...offer, ...change } as MarketplaceOffer] },
        offer,
        1000,
      ),
    ).toBe(false);
  });
});
