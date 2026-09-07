import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMarketplaceReadiness, loadMarketplacePage, loadMarketplaceToken } from "./marketplace";

const mocks = vi.hoisted(() => ({
  catalogue: vi.fn(),
  metadata: vi.fn(),
  external: vi.fn(),
  detail: vi.fn(),
  local: vi.fn(),
  key: vi.fn(),
  configured: vi.fn(),
  ready: vi.fn(),
  owner: vi.fn(),
}));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("@/services/marketplace-catalogue", () => ({
  getMarketplaceCatalogue: mocks.catalogue,
  getMarketplaceMetadata: mocks.metadata,
}));
vi.mock("@/services/marketplace-opensea", () => ({
  listOpenSeaMarketplace: mocks.external,
  getOpenSeaTokenListing: mocks.detail,
  marketplaceOpenSeaConfigured: mocks.key,
}));
vi.mock("@/services/marketplace-orders", () => ({
  listMarketplaceOrders: mocks.local,
  marketplaceStorageConfigured: mocks.configured,
  marketplaceStorageReady: mocks.ready,
}));
vi.mock("viem", async (original) => ({
  ...(await original<typeof import("viem")>()),
  createPublicClient: () => ({ readContract: mocks.owner }),
}));

const owner = "0x1111111111111111111111111111111111111111";
const nft = { tokenId: "12", name: "Gnar #12", image: null, owner, offers: [] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.key.mockReturnValue(false);
  mocks.configured.mockReturnValue(false);
  mocks.ready.mockResolvedValue(false);
  mocks.catalogue.mockResolvedValue({ items: [structuredClone(nft)], nextCursor: null });
  mocks.metadata.mockImplementation(async () => [structuredClone(nft)]);
  mocks.owner.mockResolvedValue(owner);
  mocks.external.mockResolvedValue({ offers: [], nextCursor: null });
  mocks.local.mockResolvedValue({ offers: [], nextCursor: null });
});

describe("marketplace source availability", () => {
  it("keeps catalogue usable without pretending missing providers have no listings", async () => {
    const page = await loadMarketplacePage({ view: "catalogue" });
    expect(page.items).toHaveLength(1);
    expect(page.sources).toEqual({
      catalogue: { available: true },
      opensea: { available: false, error: "not_configured" },
      gnars: { available: false, error: "not_configured" },
    });
    expect(page.capabilities).toEqual({
      openseaBuy: false,
      openseaSell: false,
      openseaCancel: false,
      localTrading: false,
    });
    expect(mocks.external).not.toHaveBeenCalled();
  });
  it("enables OpenSea purchases with only an API key, without enabling local order storage", async () => {
    mocks.key.mockReturnValue(true);
    expect(await getMarketplaceReadiness()).toMatchObject({
      sources: { opensea: { available: true } },
      capabilities: {
        openseaBuy: true,
        openseaSell: true,
        openseaCancel: true,
        localTrading: false,
      },
    });
    expect(await loadMarketplacePage({ view: "listings" })).toMatchObject({
      capabilities: {
        openseaBuy: true,
        openseaSell: true,
        openseaCancel: true,
        localTrading: false,
      },
    });
    mocks.detail.mockResolvedValueOnce(null);
    expect(await loadMarketplaceToken("12")).toMatchObject({
      capabilities: {
        openseaBuy: true,
        openseaSell: true,
        openseaCancel: true,
        localTrading: false,
      },
    });
  });
  it("marks a catalogue read failure explicitly unavailable", async () => {
    mocks.catalogue.mockRejectedValueOnce(new Error("indexer unavailable"));
    expect(await loadMarketplacePage({ view: "catalogue" })).toMatchObject({
      items: [],
      sources: { catalogue: { available: false, error: "unavailable" } },
    });
  });
  it("requires an owner in owned mode and rejects malformed/cross-view cursors", async () => {
    await expect(loadMarketplacePage({ view: "owned" })).rejects.toMatchObject({ status: 400 });
    await expect(
      loadMarketplacePage({ view: "catalogue", cursor: "not-json" }),
    ).rejects.toMatchObject({ status: 400 });
    const cursor = Buffer.from(JSON.stringify({ view: "owned", catalogue: "12" })).toString(
      "base64url",
    );
    await expect(loadMarketplacePage({ view: "catalogue", cursor })).rejects.toMatchObject({
      status: 400,
    });
  });
  it("does not fetch an already exhausted provider when paginating another source", async () => {
    mocks.key.mockReturnValue(true);
    mocks.ready.mockResolvedValue(true);
    const cursor = Buffer.from(
      JSON.stringify({ view: "listings", opensea: null, gnars: "123" }),
    ).toString("base64url");
    await loadMarketplacePage({ view: "listings", cursor });
    expect(mocks.external).not.toHaveBeenCalled();
    expect(mocks.local).toHaveBeenCalledWith("123");
  });
  it("reports provider failure instead of an available empty listing page", async () => {
    mocks.key.mockReturnValue(true);
    mocks.ready.mockResolvedValue(true);
    mocks.external.mockRejectedValueOnce(new Error("quota exceeded"));
    expect(await loadMarketplacePage({ view: "listings" })).toMatchObject({
      sources: { opensea: { available: false, error: "unavailable" } },
      capabilities: { openseaBuy: false, openseaSell: false, openseaCancel: false },
    });
  });
  it("loads NFT offers on demand and checks the current on-chain owner", async () => {
    mocks.key.mockReturnValue(true);
    mocks.detail.mockResolvedValue(null);
    const page = await loadMarketplaceToken("12");
    expect(page.items[0].owner).toBe(owner);
    expect(mocks.detail).toHaveBeenCalledWith("12");
    expect(mocks.owner).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "ownerOf", args: [12n] }),
    );
  });
});
