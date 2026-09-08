import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMarketplaceReadiness, loadMarketplacePage, loadMarketplaceToken } from "./marketplace";

const mocks = vi.hoisted(() => ({
  catalogue: vi.fn(),
  metadata: vi.fn(),
  external: vi.fn(),
  detail: vi.fn(),
  ownerListings: vi.fn(),
  selling: vi.fn(),
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
  getOpenSeaOwnerListings: mocks.ownerListings,
  listOpenSeaOwnerMarketplace: mocks.selling,
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
  mocks.ownerListings.mockResolvedValue({ offers: [], partial: false });
  mocks.selling.mockResolvedValue({ offers: [], nextCursor: null, partial: false });
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
    await expect(loadMarketplacePage({ view: "selling" })).rejects.toMatchObject({ status: 400 });
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
  it("loads selling inventory from seller-filtered orderbooks rather than an NFT inventory page", async () => {
    mocks.key.mockReturnValue(true);
    mocks.ready.mockResolvedValue(true);
    const offer = {
      id: "opensea:mine",
      seller: owner,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    mocks.selling.mockResolvedValueOnce({
      offers: [{ tokenId: "12", offer }],
      nextCursor: "mine-next",
      partial: false,
    });
    const page = await loadMarketplacePage({ view: "selling", owner });
    expect(mocks.selling).toHaveBeenCalledExactlyOnceWith(owner, undefined);
    expect(mocks.local).toHaveBeenCalledExactlyOnceWith(undefined, undefined, owner);
    expect(mocks.catalogue).not.toHaveBeenCalled();
    expect(mocks.external).not.toHaveBeenCalled();
    expect(page.items[0].offers).toEqual([offer]);
    const cursor = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString());
    expect(cursor).toMatchObject({ view: "selling", owner, opensea: "mine-next" });
    await expect(
      loadMarketplacePage({
        view: "selling",
        owner: "0x2222222222222222222222222222222222222222",
        cursor: page.nextCursor!,
      }),
    ).rejects.toMatchObject({ status: 400 });
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
  it("preserves the provider price order when metadata arrives in token ID order", async () => {
    mocks.key.mockReturnValue(true);
    const future = Math.floor(Date.now() / 1000) + 3600;
    mocks.external.mockResolvedValueOnce({
      offers: [
        { tokenId: "12", offer: { seller: owner, priceWei: "100", expiresAt: future } },
        { tokenId: "99", offer: { seller: owner, priceWei: "200", expiresAt: future } },
      ],
      nextCursor: null,
    });
    mocks.metadata.mockResolvedValueOnce([
      { ...nft, tokenId: "99", offers: [] },
      { ...nft, offers: [] },
    ]);
    const page = await loadMarketplacePage({ view: "listings" });
    expect(page.items.map((item) => item.tokenId)).toEqual(["12", "99"]);
  });
  it("reports provider failure instead of an available empty listing page", async () => {
    mocks.key.mockReturnValue(true);
    mocks.ready.mockResolvedValue(true);
    mocks.external.mockRejectedValueOnce(new Error("quota exceeded"));
    expect(await loadMarketplacePage({ view: "listings" })).toMatchObject({
      sources: { opensea: { available: false, error: "unavailable" } },
      capabilities: { openseaBuy: false, openseaSell: true, openseaCancel: true },
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
  it("keeps live ownership verified when optional metadata is unavailable", async () => {
    mocks.metadata.mockRejectedValueOnce(new Error("indexer offline"));
    mocks.key.mockReturnValue(true);
    mocks.detail.mockResolvedValue(null);
    const page = await loadMarketplaceToken("12");
    expect(page).toMatchObject({
      ownershipVerified: true,
      sources: { catalogue: { available: false, error: "unavailable" } },
      capabilities: { openseaSell: true },
      items: [{ tokenId: "12", owner, image: null }],
    });
    expect(mocks.owner).toHaveBeenCalledOnce();
  });
  it("never verifies ownership after an ownership RPC failure", async () => {
    mocks.owner.mockRejectedValueOnce(new Error("RPC offline"));
    await expect(loadMarketplaceToken("12")).rejects.toThrow("RPC offline");
  });
  it("does not disable selling and cancellation when a best listing is unsupported", async () => {
    mocks.key.mockReturnValue(true);
    mocks.detail.mockRejectedValueOnce(new Error("unsupported order"));
    expect(await loadMarketplaceToken("12")).toMatchObject({
      capabilities: { openseaBuy: false, openseaSell: true, openseaCancel: true },
      sources: { opensea: { available: false, error: "unavailable" } },
    });
  });
  it("retains a failed provider cursor instead of exhausting that provider", async () => {
    mocks.key.mockReturnValue(true);
    mocks.ready.mockResolvedValue(true);
    mocks.external.mockRejectedValueOnce(new Error("timeout"));
    mocks.local.mockResolvedValue({ offers: [], nextCursor: "24" });
    const cursor = Buffer.from(
      JSON.stringify({ view: "listings", opensea: "retry-me", gnars: "48" }),
    ).toString("base64url");
    const page = await loadMarketplacePage({ view: "listings", cursor });
    const next = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString());
    expect(next).toEqual({ view: "listings", opensea: "retry-me", gnars: "24" });
    await loadMarketplacePage({ view: "listings", cursor: page.nextCursor! });
    expect(mocks.external).toHaveBeenLastCalledWith("retry-me");
  });
  it("enriches owned inventory with one owner-scoped OpenSea read and reports truncation", async () => {
    mocks.key.mockReturnValue(true);
    const offer = { id: "opensea:test" };
    mocks.ownerListings.mockResolvedValueOnce({
      offers: [{ tokenId: "12", offer }],
      partial: true,
    });
    const page = await loadMarketplacePage({ view: "owned", owner });
    expect(mocks.ownerListings).toHaveBeenCalledExactlyOnceWith(owner);
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(page.items[0].offers).toEqual([offer]);
    expect(page.sources.opensea).toEqual({ available: true, partial: true });
  });
  it("does not lose verified local rows when reconciliation is partial", async () => {
    mocks.ready.mockResolvedValue(true);
    mocks.local.mockResolvedValueOnce({
      offers: [{ tokenId: "12", offer: { id: "gnars:verified" } }],
      partial: true,
    });
    const page = await loadMarketplacePage({ view: "catalogue" });
    expect(page.items[0].offers).toHaveLength(1);
    expect(page.sources.gnars).toEqual({ available: true, partial: true });
  });
});
