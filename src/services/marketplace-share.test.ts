import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DAO_ADDRESSES } from "@/lib/config";
import { loadMarketplaceToken } from "@/services/marketplace";
import { getCommunityToken } from "@/services/marketplace-community";
import { getMarketplaceShareData, loadMarketplaceShareArtwork } from "./marketplace-share";

vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("@/services/marketplace", () => ({ loadMarketplaceToken: vi.fn() }));
vi.mock("@/services/marketplace-community", () => ({ getCommunityToken: vi.fn() }));
const owner = `0x${"11".repeat(20)}`;
const hash = `0x${"22".repeat(32)}` as const;
const collection = `0x${"33".repeat(20)}` as const;
const item = {
  name: "Gnar #54",
  tokenId: "54",
  image: "https://nouns.build/art.png",
  owner,
  offers: [
    {
      source: "gnars-contract",
      seller: owner,
      orderHash: hash,
      currency: "ETH",
      priceWei: "20000000000000000",
      expiresAt: 2100000000,
    },
    {
      source: "opensea",
      seller: owner,
      orderHash: `0x${"44".repeat(32)}`,
      currency: "ETH",
      priceWei: "10000000000000000",
      expiresAt: 2100000000,
    },
  ],
};

describe("trusted marketplace share data", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });
  it("uses the canonical catalogue and requested order rather than cheapest different order", async () => {
    vi.mocked(loadMarketplaceToken).mockResolvedValue({
      items: [item],
      ownershipVerified: true,
    } as never);
    expect(
      await getMarketplaceShareData({ tokenId: "54", orderHash: hash, source: "gnars-contract" }),
    ).toMatchObject({ name: "Gnar #54", price: "0.02 ETH", source: "gnars-contract" });
    expect(loadMarketplaceToken).toHaveBeenCalledWith("54");
  });
  it("uses community metadata only for its matching collection", async () => {
    vi.mocked(getCommunityToken).mockResolvedValue({
      items: [{ ...item, collectionAddress: collection }],
      ownershipVerified: true,
    } as never);
    expect(
      await getMarketplaceShareData({ tokenId: "54", collectionAddress: collection }),
    ).toMatchObject({ price: "0.01 ETH" });
    expect(getCommunityToken).toHaveBeenCalledWith(collection, "54");
    expect(loadMarketplaceToken).not.toHaveBeenCalled();
  });
  it("canonical Gnars address still uses catalogue", async () => {
    vi.mocked(loadMarketplaceToken).mockResolvedValue({ items: [item] } as never);
    await getMarketplaceShareData({ tokenId: "54", collectionAddress: DAO_ADDRESSES.token });
    expect(getCommunityToken).not.toHaveBeenCalled();
  });
  it("missing requested order has no misleading alternate price", async () => {
    vi.mocked(loadMarketplaceToken).mockResolvedValue({
      items: [item],
      ownershipVerified: true,
    } as never);
    expect(
      await getMarketplaceShareData({
        tokenId: "54",
        orderHash: `0x${"55".repeat(32)}`,
        source: "gnars-contract",
      }),
    ).toMatchObject({ price: null, source: null });
  });
  it.each([false, undefined])(
    "omits prices when ownership is unverified (%s)",
    async (ownershipVerified) => {
      vi.mocked(loadMarketplaceToken).mockResolvedValue({
        items: [item],
        ownershipVerified,
      } as never);
      expect(await getMarketplaceShareData({ tokenId: "54" })).toMatchObject({
        name: "Gnar #54",
        price: null,
        source: null,
      });
    },
  );
  it("rejects wrong NFT metadata and degrades service failures", async () => {
    vi.mocked(loadMarketplaceToken).mockResolvedValue({
      items: [{ ...item, tokenId: "55" }],
    } as never);
    expect(await getMarketplaceShareData({ tokenId: "54" })).toBeNull();
    vi.mocked(loadMarketplaceToken).mockRejectedValue(new Error("provider failed with secret"));
    expect(await getMarketplaceShareData({ tokenId: "54" })).toBeNull();
  });
  it.each([
    "https://127.0.0.1/internal",
    "https://metadata.evil.example/art",
    "https://i.seadn.io.evil.example/art",
    "http://i.seadn.io/art",
    "https://user:secret@i.seadn.io/art",
    "https://i.seadn.io:8080/art",
    "data:image/svg+xml,<svg/>",
  ])("does not fetch untrusted artwork %s", async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadMarketplaceShareArtwork(url)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("fetches a known host without redirects and converts WebP to embedded PNG", async () => {
    const webp = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#ffcc00" },
    })
      .webp()
      .toBuffer();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array(webp), { headers: { "Content-Type": "image/webp" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await loadMarketplaceShareArtwork("https://i.seadn.io/art.png");
    expect(result).toMatch(/^data:image\/png;base64,/);
    const decoded = Buffer.from(result!.split(",")[1], "base64");
    expect((await sharp(decoded).metadata()).format).toBe("png");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://i.seadn.io/art.png"),
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    );
  });
  it("rejects malformed raster bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("bad", { headers: { "Content-Type": "image/png" } })),
    );
    expect(await loadMarketplaceShareArtwork("https://i.seadn.io/art.png")).toBeNull();
  });
  it("rejects SVG and oversized streamed images", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array(4_000_001), { headers: { "Content-Type": "image/png" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadMarketplaceShareArtwork("https://i.seadn.io/art.svg")).toBeNull();
    expect(await loadMarketplaceShareArtwork("https://i.seadn.io/art.png")).toBeNull();
  });
});
