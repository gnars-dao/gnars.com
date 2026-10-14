import { beforeEach, describe, expect, it, vi } from "vitest";
import { listExternalCollection } from "./marketplace-external-collections";

const mocks = vi.hoisted(() => ({ configured: vi.fn(), listings: vi.fn(), nft: vi.fn() }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("@/services/marketplace-opensea", () => ({
  marketplaceOpenSeaConfigured: mocks.configured,
  requestOpenSeaCollectionBestListings: mocks.listings,
  requestOpenSeaExternalNft: mocks.nft,
}));

function listing(identifier: string, value: string, currency = "ETH") {
  return { price: { current: { currency, value } }, asset: { identifier } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configured.mockReturnValue(true);
  mocks.nft.mockResolvedValue({
    nft: { name: "Noun 1", display_image_url: "https://raw2.seadn.io/a.svg" },
  });
});

describe("external collection browser", () => {
  it("reports unavailable instead of empty when OpenSea is not configured", async () => {
    mocks.configured.mockReturnValue(false);
    expect(await listExternalCollection("nouns")).toEqual({ items: [], available: false });
    expect(mocks.listings).not.toHaveBeenCalled();
  });

  it("keeps the cheapest order per token and sorts ascending", async () => {
    mocks.listings.mockResolvedValue({
      listings: [listing("7", "3000"), listing("4", "1000"), listing("7", "2000")],
    });
    const page = await listExternalCollection("nouns");
    expect(page.items.map((item) => [item.tokenId, item.priceWei])).toEqual([
      ["4", "1000"],
      ["7", "2000"],
    ]);
  });

  it("ignores listings priced in other currencies", async () => {
    mocks.listings.mockResolvedValue({
      listings: [listing("9", "500", "USDC"), listing("3", "900")],
    });
    expect((await listExternalCollection("nouns")).items.map((item) => item.tokenId)).toEqual([
      "3",
    ]);
  });

  it("links each item to its OpenSea page on the collection's chain", async () => {
    mocks.listings.mockResolvedValue({ listings: [listing("191", "1000")] });
    expect((await listExternalCollection("og")).items[0]?.url).toBe(
      "https://opensea.io/item/ethereum/0x494715b2a3c75dadd24929835b658a1c19bd4552/191",
    );
  });

  it("falls back to the token id and no artwork when metadata fails", async () => {
    mocks.listings.mockResolvedValue({ listings: [listing("12", "1000")] });
    mocks.nft.mockRejectedValue(new Error("provider down"));
    expect((await listExternalCollection("nouns")).items[0]).toMatchObject({
      name: "#12",
      image: null,
    });
  });

  it("rejects artwork URLs that are not plain https", async () => {
    mocks.listings.mockResolvedValue({ listings: [listing("12", "1000")] });
    mocks.nft.mockResolvedValue({
      nft: { name: "Noun 12", display_image_url: "javascript:alert(1)" },
    });
    expect((await listExternalCollection("nouns")).items[0]?.image).toBeNull();
  });

  it("caps the page and never asks the provider for an unbounded list", async () => {
    mocks.listings.mockResolvedValue({
      listings: Array.from({ length: 30 }, (_, index) => listing(String(index), String(index + 1))),
    });
    expect((await listExternalCollection("nouns")).items).toHaveLength(12);
    expect(mocks.listings).toHaveBeenCalledWith("nouns", 24);
  });
});
