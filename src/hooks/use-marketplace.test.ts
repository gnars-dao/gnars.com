import { describe, expect, it } from "vitest";
import type { MarketplaceOffer, MarketplacePage } from "@/types/marketplace";
import { scopeExactMarketplacePage } from "./use-marketplace";

const owner = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
function page(): MarketplacePage {
  return {
    ownershipVerified: true,
    items: [{ tokenId: "42", name: "Gnar #42", image: null, owner, offers: [] }],
    nextCursor: null,
    sources: {
      catalogue: { available: true },
      opensea: { available: false, error: "unavailable" },
      gnars: { available: true },
    },
    capabilities: {
      openseaBuy: false,
      openseaSell: true,
      openseaCancel: true,
      localTrading: true,
    },
  };
}
describe("exact marketplace wallet scope", () => {
  it("excludes another wallet's NFT from owned and selling", () => {
    expect(scopeExactMarketplacePage(page(), "owned", other).items).toEqual([]);
    expect(scopeExactMarketplacePage(page(), "selling", other).items).toEqual([]);
  });
  it("retains an owned unlisted NFT only in inventory", () => {
    expect(scopeExactMarketplacePage(page(), "owned", owner).items).toHaveLength(1);
    expect(scopeExactMarketplacePage(page(), "selling", owner).items).toEqual([]);
  });
  it("retains only the wallet's offers and preserves degraded source status", () => {
    const input = page();
    const offer: MarketplaceOffer = {
      source: "gnars" as const,
      id: "42",
      orderHash: `0x${"a".repeat(64)}` as const,
      protocolAddress: owner,
      seller: owner,
      priceWei: "1",
      currency: "ETH" as const,
      expiresAt: 2100000000,
    };
    input.items[0].offers = [offer, { ...offer, id: "foreign", seller: other }];
    const result = scopeExactMarketplacePage(input, "selling", owner);
    expect(result.items[0].offers).toEqual([offer]);
    expect(result.sources).toEqual(input.sources);
    expect(input.items[0].offers).toHaveLength(2);
  });
  it("does not report missing ownership as an empty wallet", () => {
    expect(() =>
      scopeExactMarketplacePage({ ...page(), ownershipVerified: false }, "owned", owner),
    ).toThrow();
    expect(() => scopeExactMarketplacePage(page(), "owned")).toThrow();
    const missing = page();
    missing.items[0].owner = null;
    expect(() => scopeExactMarketplacePage(missing, "owned", owner)).toThrow();
  });
  it("leaves public token lookups unchanged", () => {
    const input = page();
    expect(scopeExactMarketplacePage(input, "catalogue", other)).toBe(input);
    expect(scopeExactMarketplacePage(input, "listings", other)).toBe(input);
  });
});
